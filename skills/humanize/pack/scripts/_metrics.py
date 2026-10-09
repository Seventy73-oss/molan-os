#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""共享指标计算模块（测量层，不是门）

被以下脚本复用，保证口径完全一致：
  · narrative_probe.py   叙事层探针（测量/报告）
  · dist_check.py        门7 分布与漂移（判定）
  · build_context.py     注入包（把本章目标区间写进去）

指标分四组：
  A 段/句结构：均段长、段长sd、段长直方图、均句长、句长sd、句首重复率
  B 段落构成：对白段%、环境段%（宽/严）、环境句%
  C 用词密度：说族、明喻、承接词（AI词表/自然词表/单字虚词三口径）、术语密度
  D 情感极性：逐句极性 sd、转折点、正负比例（M4 新增）

⚠️ 所有阈值判定在 dist_check.py，本模块只算数。
"""
import re
import statistics as st

BINS = [0, 10, 20, 30, 40, 50, 60, 80, 100, 120, 10 ** 6]
BIN_LABELS = ['0-10', '11-20', '21-30', '31-40', '41-50', '51-60',
              '61-80', '81-100', '101-120', '120+']

ENV_WORDS = ('雨', '风', '云', '月', '光', '天', '夜', '晨', '暮', '雪', '雾',
             '气味', '味道', '声音', '响', '冷', '热', '湿', '泥', '石', '木',
             '墙', '屋', '门', '窗', '坡', '河', '草', '灰', '暗', '亮', '土')
SAID_WORDS = ('说', '问', '答', '道', '喊', '叫', '念', '讲', '应', '开口',
              '回', '嘟囔', '哼', '笑')
SIMILE = ('像', '仿佛', '如同', '似的', '宛如', '好像', '犹如')

# 口径一：旧「AI 腔连接词」表（11 个）—— 用来复现历史基线，不再作门的主口径
CONNECT_AI = ('因此', '所以', '然而', '于是', '另一方面', '更重要的是', '总之',
              '此外', '从而', '进而', '与此同时')

# 口径二：M2 实测的「真人自然承接词」表（覆盖率 ≥30% 的多字词，单字虚词另计）
CONNECT_NAT = (
    '不过', '只是', '虽然', '所以', '可是', '同时', '之后', '甚至', '而且',
    '结果', '这才', '反而', '再说', '接着', '然后', '接下来', '另外', '后来',
    '然而', '于是', '反正', '等到', '但是', '至少', '因此', '过后', '何况',
    '随后', '尤其', '第二天', '那天', '尽管', '随即', '与此同时', '反倒',
    '难怪', '偏偏', '跟着', '回头', '半晌', '过了一会儿', '过了会儿',
    '隔了会儿', '没多久', '不多时', '片刻后', '当晚', '这一夜', '那晚',
    '隔天', '转眼', '况且', '再者', '总之', '说到底', '归根结底',
    '无论如何', '好歹', '不管怎么说', '因而', '故而', '由此', '以致',
    '正因为', '怪不得', '虽说', '继而', '旋即', '当即', '于是乎', '一炷香',
    '半刻',
)
# 口径三：单字虚词（真人也高频，但属语法功能词，单列不入门）
CONNECT_FN = ('就', '才', '再', '便', '更', '却')

NOISE_PAT = [
    ('半角逗号', re.compile(r'[a-zA-Z0-9\u4e00-\u9fff],')),
    ('半角句号', re.compile(r'[\u4e00-\u9fff]\.')),
    ('半角引号', re.compile(r'["\']')),
    ('连续标点', re.compile(r'[，。！？；]{2,}')),
    ('省略号非标准', re.compile(r'(?<!\.)\.\.(?!\.)')),
]

# ── 情感极性词典（M4 自建，极简版；只做提名/观察）──────────────────────────
POS_WORDS = (
    '笑', '笑了', '笑意', '欢喜', '高兴', '开心', '愉快', '痛快', '舒畅', '欣慰',
    '安心', '放心', '踏实', '温暖', '热乎', '舒服', '松了口', '松了口气', '轻松',
    '满意', '得意', '骄傲', '自豪', '期待', '希望', '盼望', '憧憬', '感激', '感动',
    '温柔', '亲切', '和善', '善良', '好心', '帮忙', '救', '护', '保护', '守护',
    '相信', '信任', '可靠', '稳当', '妥当', '妥帖', '漂亮', '好看', '美', '精致',
    '干净', '整齐', '新鲜', '香', '甜', '暖', '亮堂', '明亮', '晴朗', '清爽',
    '赢', '胜', '成功', '成了', '办成', '解决了', '搞定', '过关', '好转', '恢复',
    '强壮', '有力', '利落', '熟练', '准确', '清楚', '明白', '懂了', '对了',
    '好', '不错', '很好', '挺好', '妙', '妙极', '厉害', '了不起', '值',
    '喜', '乐', '安', '宁', '稳', '顺', '快意', '畅快', '热切', '亲切',
)
NEG_WORDS = (
    '哭', '哭腔', '泪', '眼泪', '悲', '悲伤', '悲痛', '凄凉', '酸楚', '苦涩',
    '难受', '痛苦', '疼', '痛', '剧痛', '刺痛', '恶心', '头晕', '昏', '虚弱',
    '疲惫', '累', '乏力', '喘', '窒息', '冷汗', '发抖', '哆嗦', '颤', '僵硬',
    '害怕', '恐惧', '怕', '慌', '慌张', '慌神', '不安', '焦虑', '烦躁', '恼',
    '怒', '愤怒', '恼火', '火大', '恨', '仇', '厌恶', '嫌', '恶心', '失望',
    '绝望', '沮丧', '灰心', '消沉', '麻木', '空洞', '茫然', '迷茫', '困惑',
    '怀疑', '不信', '警惕', '戒备', '敌意', '威胁', '危险', '糟', '糟糕',
    '坏了', '坏了事', '完蛋', '失败', '输', '错了', '出错', '失误', '漏洞',
    '死', '尸体', '血', '腥', '腐', '烂', '臭', '脏', '乱', '破', '裂', '碎',
    '空', '冷清', '阴暗', '昏暗', '阴森', '寒', '冰冷', '刺骨', '压抑', '沉重',
    '沉默', '尴尬', '别扭', '难堪', '丢脸', '羞愧', '后悔', '懊恼', '无奈',
    '不得不', '勉强', '硬着', '忍着', '撑', '熬', '僵持', '冲突', '争吵',
)
NEGATORS = ('不', '没', '无', '非', '别', '莫', '未', '否', '勿', '甭')
INTENSIFIERS = {'很': 1.5, '非常': 1.8, '特别': 1.6, '极': 1.8, '太': 1.6,
                '十分': 1.6, '格外': 1.6, '异常': 1.6, '极其': 1.9, '更加': 1.4,
                '尤其': 1.4, '更': 1.3, '最': 1.8, '有点': 0.6, '有些': 0.6,
                '略微': 0.6, '稍微': 0.6, '一点': 0.6, '几乎': 0.8}


def split_paras(text):
    return [p.strip() for p in text.split('\n') if p.strip()]


def split_sents(text):
    return [s for s in re.split(r'(?<=[。！？…”」])', text) if s.strip()]


def norm_len(s):
    return len(re.sub(r'\s', '', s))


def _alt_re(words):
    return re.compile('|'.join(re.escape(w) for w in sorted(words, key=len, reverse=True)))


POS_RE = _alt_re(POS_WORDS)
NEG_RE = _alt_re(NEG_WORDS)
INT_RE = _alt_re(INTENSIFIERS.keys())
NEGATOR_RE = _alt_re(NEGATORS)


def _polarity(text):
    """极简规则法极性：词命中 + 程度副词加权 + 否定翻转。返回 (score, pos, neg)。

    V0.38 优化：词典合并成单条正则（原来 200+ 次 finditer 太慢，133 本跑不完）。
    """
    pos = neg = 0.0
    for m in POS_RE.finditer(text):
        ctx = text[max(0, m.start() - 4):m.start()]
        wgt = 1.0
        im = None
        for im in INT_RE.finditer(ctx):
            pass
        if im:
            wgt *= INTENSIFIERS.get(im.group(), 1.0)
        if ctx and NEGATOR_RE.fullmatch(ctx[-1]):
            neg += wgt
        else:
            pos += wgt
    for m in NEG_RE.finditer(text):
        ctx = text[max(0, m.start() - 4):m.start()]
        wgt = 1.0
        im = None
        for im in INT_RE.finditer(ctx):
            pass
        if im:
            wgt *= INTENSIFIERS.get(im.group(), 1.0)
        if ctx and NEGATOR_RE.fullmatch(ctx[-1]):
            pos += wgt * 0.6
        else:
            neg += wgt
    return pos - neg, pos, neg


TITLE_RE = re.compile(r'^\s*第[零一二三四五六七八九十百千0-9]+章[^\n]*\n+')


def probe(text, name=''):
    # 章标题是元数据、不是叙述段落（真人语料切片里没有标题），先去标题再统计
    text = TITLE_RE.sub('', text)
    paras = split_paras(text)
    plens = [norm_len(p) for p in paras]
    hist = [0] * (len(BINS) - 1)
    for L in plens:
        for i in range(len(BINS) - 1):
            if BINS[i] < L <= BINS[i + 1]:
                hist[i] += 1
                break
        else:
            if L <= BINS[1]:
                hist[0] += 1
    sents = split_sents(text)
    slens = [norm_len(s) for s in sents if norm_len(s) >= 2]
    heads = [re.sub(r'[^\u4e00-\u9fff]', '', s)[:2] for s in sents]
    heads = [h for h in heads if len(h) == 2]
    head_top = {}
    for h in heads:
        head_top[h] = head_top.get(h, 0) + 1
    head_rep = (max(head_top.values()) / len(heads)) if heads else 0

    n_para = len(paras) or 1
    dlg = sum(1 for p in paras if ('“' in p or '「' in p))
    env = sum(1 for p in paras
              if ('“' not in p and '「' not in p) and any(w in p for w in ENV_WORDS))
    env2 = sum(1 for p in paras
               if ('“' not in p and '「' not in p)
               and sum(1 for w in ENV_WORDS if w in p) >= 2)
    envs = sum(1 for s in sents
               if ('“' not in s and '「' not in s) and any(w in s for w in ENV_WORDS))
    said = sum(len(re.findall(w, text)) for w in SAID_WORDS)
    simp = sum(len(re.findall(w, text)) for w in SIMILE)
    conn_ai = sum(len(re.findall(w, text)) for w in CONNECT_AI)
    conn_nat = sum(len(re.findall(w, text)) for w in CONNECT_NAT)
    conn_fn = sum(len(re.findall(w, text)) for w in CONNECT_FN)
    chars = norm_len(text)
    noise = {k: len(p.findall(text)) for k, p in NOISE_PAT}

    # 情感极性
    pol = []
    for s in sents:
        if norm_len(s) < 2:
            continue
        sc, _, _ = _polarity(s)
        pol.append(sc)
    pol_sd = st.pstdev(pol) if len(pol) > 1 else 0.0
    turns = 0
    for i in range(1, len(pol)):
        a, b = pol[i - 1], pol[i]
        if a * b < 0 and abs(a - b) >= 2:
            turns += 1
    pos_sents = sum(1 for x in pol if x > 0)
    neg_sents = sum(1 for x in pol if x < 0)

    return {
        'name': name, 'chars': chars, 'paras': len(paras),
        'pmean': st.mean(plens) if plens else 0,
        'psd': st.pstdev(plens) if len(plens) > 1 else 0,
        'hist': hist,
        'sents': len(slens),
        'smean': st.mean(slens) if slens else 0,
        'ssd': st.pstdev(slens) if len(slens) > 1 else 0,
        'head_rep': head_rep, 'head_top': sorted(head_top.items(), key=lambda x: -x[1])[:3],
        'dlg_pct': 100.0 * dlg / n_para,
        'env_pct': 100.0 * env / n_para,
        'env2_pct': 100.0 * env2 / n_para,
        'envsent_pct': 100.0 * envs / (len(sents) or 1),
        'said_kilo': 1000.0 * said / chars if chars else 0,
        'simile_kilo': 1000.0 * simp / chars if chars else 0,
        'conn_ai_kilo': 1000.0 * conn_ai / chars if chars else 0,
        'conn_nat_kilo': 1000.0 * conn_nat / chars if chars else 0,
        'conn_fn_kilo': 1000.0 * conn_fn / chars if chars else 0,
        'conn_kilo': 1000.0 * conn_ai / chars if chars else 0,   # 向后兼容
        'noise': noise,
        'pol_sd': pol_sd,
        'pol_turns_kilo': 1000.0 * turns / chars if chars else 0,
        'pol_pos_pct': 100.0 * pos_sents / (len(pol) or 1),
        'pol_neg_pct': 100.0 * neg_sents / (len(pol) or 1),
        'pol_turns': turns,
    }


def saddle(hist):
    """中段塌陷检测：找峰值 bin，看是否存在'两侧高、中间低'的鞍部。"""
    if sum(hist) < 12:
        return None
    peak = hist.index(max(hist))
    best = None
    for i in range(1, len(hist) - 1):
        if hist[i] < hist[i - 1] and hist[i] < hist[i + 1]:
            depth = min(hist[i - 1], hist[i + 1]) - hist[i]
            if best is None or depth > best[1]:
                best = (i, depth)
    return {'peak': peak, 'saddle': best}


def read_text(path):
    import io
    try:
        return io.open(path, encoding='utf-8').read()
    except Exception:
        return io.open(path, encoding='gb18030', errors='replace').read()


def probe_file(path, sample_chars=None, cache_dir=None):
    """读文件并计算指标；带磁盘缓存（键＝路径+mtime+size+采样长度）。

    语料基线要反复重算，情感词典是全量扫描，没缓存跑一次 133 本要几分钟。
    """
    import hashlib
    import json
    import os
    stt = os.stat(path)
    key = '%s|%d|%d|%s' % (os.path.basename(path), stt.st_mtime_ns, stt.st_size,
                           sample_chars or 'full')
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        cp = os.path.join(cache_dir, hashlib.md5(key.encode('utf-8')).hexdigest() + '.json')
        if os.path.exists(cp):
            try:
                return json.load(open(cp, encoding='utf-8'))
            except Exception:
                pass
    text = read_text(path)
    if sample_chars:
        text = text[:sample_chars]
    r = probe(text, os.path.basename(path))
    if cache_dir:
        try:
            json.dump(r, open(cp, 'w', encoding='utf-8'), ensure_ascii=False)
        except Exception:
            pass
    return r
