# -*- coding: utf-8 -*-
"""
去 AI 味训练数据构造 v2 —— 多算子随机退化

设计原理（类比图像去噪训练）：
    加**各不相同**的噪声，target 永远是同一张干净图 → 模型学会"干净图像"的流形本身。
    同理，这里对同一段人类网文施加千变万化的"AI 味"退化，target 永远是原文。
    模型无法死记某一种变换，只能去学"好网文长什么样"。

与 v1（build_revision_data.py）的本质区别：
    v1 只有一种固定退化（切段落 + 加省略号）→ 模型会过拟合到这一种，换个 LLM 就失效。
    v2 用 8 个算子随机组合、随机强度 → 退化空间连续，模型被迫泛化。

算子设计铁律：**全部可逆，绝不丢信息**。
    只做"加噪声"（插入 AI 腔词、插连接词、插总结句、插说道标签）和"切分"（段落/句子），
    不做"具体名词→泛化名词"这类不可逆替换 —— 那种信息丢了，3B 模型变不回来。

产出：corpus/train/deai_revision.jsonl
"""
import os, re, json, random, argparse, sys
sys.stdout.reconfigure(encoding='utf-8')

DATA = 'E:/agent文章内容/corpus/train/webnovel_alpaca.jsonl'
OUT = 'E:/agent文章内容/corpus/train/deai_revision.jsonl'

INSTR = ("请把下面这段小说文字改写成地道的网文风格。"
         "保持剧情、人物和对话内容完全不变，只调整段落节奏、句子长度和语言表达，去掉机器腔。\n\n")

# ── 噪声词库（来自 never-list.md 与 anti-ai-cn.md）──
CONNECTORS = ['然而', '与此同时', '值得一提的是', '不得不说', '总而言之',
              '客观来说', '从某种意义上讲', '在现代社会的背景下', '无独有偶']
FILLERS = ['似乎', '仿佛', '某种程度上', '可以说', '在一定程度上', '大体上']
SUMMARIES = ['总之，情况就是这样。', '就这样，一天过去了。', '时间悄然流逝。',
             '这一切，都还只是开始。', '而他并不知道，更大的考验还在后面。']

SENT_END = re.compile(r'([。！？])')
FRAG = re.compile(r'[^，。！？；：]+[，。！？；：]?')


# ══════════════════ 退化算子 ══════════════════

def _merge_tiny(frags, minlen=4):
    """把孤立引号、单字碎片并回相邻片段——绝不让 '"' 单独成段"""
    out = []
    for f in frags:
        if out and len(f.strip()) <= minlen:
            out[-1] = out[-1] + f
        else:
            out.append(f)
    if len(out) > 1 and len(out[0].strip()) <= minlen:
        out[1] = out[0] + out[1]
        out = out[1:]
    return [f for f in out if f.strip()]


def op_split_para(text, target, rnd):
    """段落切碎：按标点把长段切成短段独立成行"""
    paras = [p.strip() for p in text.split('\n') if p.strip()]
    out = []
    for p in paras:
        frags = _merge_tiny([f for f in FRAG.findall(p) if f.strip()])
        if not frags:
            out.append(p); continue
        buf = ''
        for f in frags:
            buf += f
            if len(buf) >= target or rnd.random() < 0.4:
                out.append(buf.strip()); buf = ''
        if buf.strip():
            out.append(buf.strip())
    return '\n'.join(out)


def op_split_sent(text, maxlen, rnd):
    """句子切碎：长句按逗号断成独立短句"""
    lines = []
    for p in text.split('\n'):
        p = p.strip()
        if not p:
            continue
        if len(p) <= maxlen:
            lines.append(p); continue
        parts = re.split(r'(?<=[，、])', p)
        buf = ''
        for s in parts:
            buf += s
            if len(buf) >= maxlen:
                lines.append(buf.strip()); buf = ''
        if buf.strip():
            lines.append(buf.strip())
    return '\n'.join(lines)


def op_ellipsis(text, per_k, rnd):
    """省略号注入：把句号改成……，制造廉价留白"""
    paras = text.split('\n')
    total = sum(len(p) for p in paras)
    n = max(1, int(total / 1000 * per_k))
    cand = [i for i, p in enumerate(paras)
            if p.rstrip().endswith(('。', '！', '？')) and len(p) <= 40]
    for i in rnd.sample(cand, min(n, len(cand))):
        paras[i] = paras[i].rstrip()[:-1] + '……'
    return '\n'.join(paras)


def op_dash(text, per_k, rnd):
    """破折号注入：话说到一半被打断式"""
    paras = text.split('\n')
    total = sum(len(p) for p in paras)
    n = max(1, int(total / 1000 * per_k))
    cand = [i for i, p in enumerate(paras) if 8 <= len(p) <= 45 and p.rstrip().endswith(('。', '，'))]
    for i in rnd.sample(cand, min(n, len(cand))):
        p = paras[i].rstrip()
        paras[i] = p[:-1] + '——' if p.endswith('，') else p + '——'
    return '\n'.join(paras)


def op_connector(text, n, rnd):
    """AI 腔连接词注入：段落开头硬塞"然而""与此同时"等"""
    paras = text.split('\n')
    idx = [i for i, p in enumerate(paras) if len(p) >= 10]
    for i in rnd.sample(idx, min(n, len(idx))):
        paras[i] = rnd.choice(CONNECTORS) + '，' + paras[i]
    return '\n'.join(paras)


def op_filler(text, n, rnd):
    """模糊语注入：把肯定陈述变成"似乎""某种程度上"式的软表达"""
    paras = text.split('\n')
    idx = [i for i, p in enumerate(paras) if len(p) >= 12]
    for i in rnd.sample(idx, min(n, len(idx))):
        p = paras[i]
        # 只在标点之后插入——切进词里的噪声不可逆，3B 变不回来
        pos = [m.end() for m in re.finditer(r'[，。！？；：、]', p)]
        if not pos:
            continue
        cut = rnd.choice(pos)
        paras[i] = p[:cut] + rnd.choice(FILLERS) + p[cut:]
    return '\n'.join(paras)


def op_summary(text, n, rnd):
    """总结句注入：章末/段末硬加概括性收尾"""
    paras = text.split('\n')
    for _ in range(min(n, 3)):
        pos = rnd.randint(max(0, len(paras) - 8), len(paras))
        paras.insert(pos, rnd.choice(SUMMARIES))
    return '\n'.join(paras)


def op_said_tag(text, n, rnd):
    """说话人标签注入：把裸对话改成"XX说道："式，never-list 明令禁止"""
    paras = text.split('\n')
    subj = ['他', '她', '我', '老者', '少年']
    cand = [i for i, p in enumerate(paras)
            if p.strip().startswith(('“', '"')) and len(p) > 6]
    for i in rnd.sample(cand, min(n, len(cand))):
        p = paras[i].strip()
        paras[i] = f'{rnd.choice(subj)}说道：{p}'
    return '\n'.join(paras)


def op_uniform_sent(text, rnd):
    """句长均匀化：长句砍断、短句粘连，抹掉天然节奏（最响的机器信号）"""
    out = []
    for p in text.split('\n'):
        p = p.strip()
        if not p:
            continue
        sents = [s for s in re.split(r'(?<=[。！？])', p) if s.strip()]
        if len(sents) < 2:
            out.append(p); continue
        avg = sum(len(s) for s in sents) / len(sents)
        buf = ''
        for s in sents:
            buf += s
            if len(buf) >= avg * 0.8:
                out.append(buf.strip()); buf = ''
        if buf.strip():
            out.append(buf.strip())
    return '\n'.join(out)


# 算子池：(函数, 参数生成lambda, 权重)
OPS = [
    (op_split_para, lambda r: {'target': r.randint(8, 26)}, 3),      # 几乎必选：短段癌是头号症状
    (op_ellipsis, lambda r: {'per_k': r.uniform(2.0, 10.0)}, 2),
    (op_connector, lambda r: {'n': r.randint(1, 5)}, 2),
    (op_summary, lambda r: {'n': r.randint(1, 3)}, 1),
    (op_said_tag, lambda r: {'n': r.randint(1, 6)}, 2),
    (op_filler, lambda r: {'n': r.randint(1, 4)}, 1),
    (op_split_sent, lambda r: {'maxlen': r.randint(14, 30)}, 1),
    (op_uniform_sent, lambda r: {}, 1),
    (op_dash, lambda r: {'per_k': r.uniform(0.5, 3.0)}, 1),
]


def degrade(text, rnd, k_min=3, k_max=6):
    """随机抽 3~6 个算子，随机顺序施加"""
    pool, weights = [], []
    for fn, mk, w in OPS:
        pool.append((fn, mk)); weights.append(w)

    k = rnd.randint(k_min, k_max)
    picked = []
    idxs = list(range(len(pool)))
    for _ in range(k):
        if not idxs:
            break
        i = rnd.choices(idxs, weights=[weights[j] for j in idxs])[0]
        picked.append(pool[i])
        idxs.remove(i)

    for fn, mk in picked:
        try:
            text = fn(text, rnd=rnd, **mk(rnd))
        except Exception:
            pass
    return text


def stats(text):
    paras = [p.strip() for p in text.split('\n') if p.strip()]
    if not paras:
        return None
    L = [len(p) for p in paras]
    chars = sum(L)
    return {
        '段数': len(L),
        '平均段长': round(sum(L) / len(L), 1),
        '1-15字%': round(sum(1 for x in L if x <= 15) / len(L) * 100, 1),
        '省略号/千字': round(text.count('……') / chars * 1000, 2),
        '字符数': chars,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max_samples', type=int, default=None)
    ap.add_argument('--min_chars', type=int, default=600)
    ap.add_argument('--max_chars', type=int, default=1000)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--para_min', type=float, default=22.0)
    ap.add_argument('--ellipsis_max_src', type=float, default=4.0)
    ap.add_argument('--para_max_src', type=float, default=70.0)
    ap.add_argument('--preview', type=int, default=0)
    args = ap.parse_args()

    rnd = random.Random(args.seed)
    n = 0
    fout = None if args.preview else open(OUT, 'w', encoding='utf-8')

    with open(DATA, encoding='utf-8') as f:
        for line in f:
            if args.max_samples and n >= args.max_samples:
                break
            r = json.loads(line)
            orig = r['output'].strip()
            if len(orig) < args.min_chars:
                continue
            orig = orig[:args.max_chars]
            if '\n' in orig:
                orig = orig[:orig.rfind('\n')].strip()
            if len(orig) < args.min_chars:
                continue

            # 质量闸门：output 必须是"标准好风格"。
            #   段落本身要接近基线 37.6 字；自身省略号密度也不能超标（语料里有些书本身就
            #   爱用省略号，拿它当靶子会把模型的坏习惯固化）。
            st = stats(orig)
            if not st or not (args.para_min <= st['平均段长'] <= args.para_max_src):
                continue
            if st['省略号/千字'] > args.ellipsis_max_src:
                continue

            deg = degrade(orig, rnd)

            if args.preview and n < args.preview:
                print(f'===== 样本 {n+1} =====')
                print('--- 退化版（input）前 350 字 ---')
                print(deg[:350])
                print('--- 原文（output）前 350 字 ---')
                print(orig[:350])
                print('退化版统计:', stats(deg))
                print('原文统计  :', stats(orig))
                print()

            if fout:
                fout.write(json.dumps({'instruction': INSTR + deg, 'output': orig},
                                      ensure_ascii=False) + '\n')
            n += 1

    if fout:
        fout.close()
        print(f'[done] {n} 条配对 -> {OUT}  ({os.path.getsize(OUT)/1024/1024:.1f} MB)')
    else:
        print(f'[preview] 共 {n} 条')


if __name__ == '__main__':
    main()
