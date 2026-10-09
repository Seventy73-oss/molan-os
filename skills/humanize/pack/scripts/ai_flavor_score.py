# -*- coding: utf-8 -*-
"""
AI味评分器（规则版·语料校准）—— 融合 humanizer-zh / qu-ai-wei / shuorenhua
阈值不是拍脑袋：用 600 个真人语料章节校准，取真人分布 p90~p97 为报警线。
0~100 分（0=人味，100=AI味），通过线 40。
可选 BERT 检测器：models/ai-detector 存在即自动叠加。
"""
import re

# ── Tier1 一票命中 ──────────────────────────────────────────────
TIER1 = [
    (r'值得一提(的是|)', '元叙述套话'),
    (r'不得不说', '元叙述套话'),
    (r'总而言之|综上', '总结腔'),
    (r'在这个[^。]{0,12}的时代', '开场套话'),
    (r'故事(才|，才)刚刚开始', '收尾套话'),
    (r'这(或许|也许)就是', '收尾升华'),
    (r'(终于)?明白了?[^。]{0,12}(道理|意义|真谛)', '收尾升华'),
    (r'一股?难以言喻的', '空洞渲染'),
    (r'复杂的情绪', '空洞渲染'),
    (r'眸[中子]闪过一丝', '网文AI腔'),
    (r'嘴角(勾起|扬起)一抹', '网文AI腔'),
    (r'空气(仿佛|似乎)(凝固|凝滞)', '网文AI腔'),
    (r'时间仿佛(在这一刻)?静止', '网文AI腔'),
    (r'阳光明媚', '开场套话'),
    (r'在这个繁华的', '开场套话'),
]
# ── Tier2 聚集信号：真人语料 p90≈0，同段扎堆即报警 ────────────────
TIER2 = [
    (r'然而|与此同时|随即|紧接着|显然|顿时', '连接词扎堆'),
    (r'深深地|缓缓地|静静地|默默地|狠狠地', '渲染副词扎堆'),
    (r'不是[^。，]{1,12}而是', '否定式排比'),
]
SANLIAN = re.compile(r'[^，。！？\n]{1,8}[，,][^，。！？\n]{1,8}[，,][^，。！？\n]{1,8}[。！？]')
TIER3_WORDS = r'重要|关键|核心|瞬间|刹那|命运'
DIALOG_TAG = re.compile(r'(说道|问道|答道|喝道|沉声道|开口道|冷声道)')

# ── Tier 4：新增 AI 味特征（真人语料 700 章校准，阈值=分布 p97）──
# 校准脚本：calibrate_ai_tells.py（改正则后请重跑对齐阈值）
# 格式：(正则, 名称, 每千字阈值, 建议模板)
TIER4 = [
    (r'像[^，。！？]{0,10}一样|仿佛|似乎|如同|宛如|好似|犹如|似的', '明喻过密', 2.2,
     '明喻{:.1f}/千字（真人p97=2.75，AI常超3）。砍掉一半比喻，"像…一样"尽量改成直接陈述'),
    (r'仿佛在(预示|暗示|诉说|告诉|等待|宣告|提醒|召唤)|似乎有什么|好像有什么|仿佛有什么'
     r'|似乎在(暗示|告诉|诉说|等待)|像是有什么', '占位模糊句', 0.1,
     '删掉"仿佛在预示着什么"这类无信息量的悬疑占位句——它不传达任何内容，直接写发生了什么'),
    (r'紧绷的肩膀|攥紧(了)?(拳头|拳)|指甲.{0,6}掐进|深吸一口气|深吸了口气|咬了咬牙|皱了皱眉'
     r'|握紧(了)?(拳头|拳)|拳头.{0,4}咯吱|攥着拳', '身体语言套路', 0.41,
     '"攥紧拳头/深吸一口气/咬了咬牙"是AI写情绪的默认动作（每千字{:.1f}处，真人p97=0.44），'
     '换成这个人物此刻独有的反应'),
    (r'眼神|神色|神情|目光[里中]|眸[子里中]', '眼神神色过密', 0.93,
     '"眼神/神色/眸子"{:.1f}/千字（真人p97=1.38）。AI靠写眼神交代情绪，改用动作、台词或具体行为'),
    (r'不禁|不由得|情不自禁', '不禁不由得', 0.51,
     '"不禁/不由得/情不自禁"{:.1f}/千字（真人p97=0.83）是AI式情绪过渡词，删掉直接写反应'),
    (r'缓缓|轻轻|微微|悄悄|慢慢|徐徐', '轻缓副词过密', 1.33,
     '"缓缓/轻轻/微微/慢慢"{:.1f}/千字（真人p97=1.71）。只保留真正需要慢的地方1~2处'),
    (r'有的[^，。！？]{1,12}[，,][^。！？]{0,24}有的', '对称有的句式', 0.1,
     '"有的…有的…"对称罗列是典型AI腔，改成不对称的、带具体细节的描写'),
    (r'(空气|四周|周围|空气中)(中)?(弥漫|充斥|飘荡|荡漾|弥漫开)着', '感官堆砌', 0.1,
     '"空气中弥漫着…"是模板化环境描写，改成人物实际闻到/看到/碰到的具体东西'),
    (r'所到之处|无一例外|与此同时|不知为何|说不清道不明', '所到之处类', 0.42,
     '"所到之处/无一例外/与此同时"是AI总括腔（真人p97=0.45），删掉或换成具体描述'),
]


def local_phrase_repeat(t, win=400, minc=3):
    """局部短语重复：同一 3 字片段在 win 字窗口内出现 >= minc 次。
    例：'紫色的天光' 在 300 字内出现 4 次 → 命中。
    全局重复率无效（网文本身重复多），必须限定窗口才是 AI 特征。"""
    s = re.sub(r'[\s，。！？!?…：；:、“”‘’（）()《》]', '', t or '')
    if len(s) < 200:
        return 0
    pos = {}
    for i in range(len(s) - 2):
        pos.setdefault(s[i:i + 3], []).append(i)
    n = 0
    for _g, ps in pos.items():
        if len(ps) < minc:
            continue
        for j in range(len(ps) - minc + 1):
            if ps[j + minc - 1] - ps[j] < win:
                n += 1
                break
    return n

# ── 语料校准线 ─────────────────────────────────────────────────
# 重要：阈值必须按【单章密度分布】定，不能按【全局聚合密度】定。
# 旧版用聚合密度定阈值（如破折号 p90=1.45），套到单章上实测误伤 25%~39%。
# 2026-08-31 用 783 章真人语料重校（脚本 calibrate_ai_tells.py），统一取单章 p90。
TH = {
    'dash_per_1k': 4.5,     # 单章 p90=4.49（旧2.0误伤25.2%）
    'long_para_pct': 30.0,  # 单章 p90=30.7（旧20误伤12.9%）；描写重的章节省份，只拦极端
    'run_short': 4,         # 单章 p90=3, p97=5，实测误伤3.2%，保持
    'sanlian_per_1k': 9.0,  # 实测误伤2.0%，保持
    'exclaim_per_1k': 12.5, # 单章 p90=12.45（旧4.5误伤38.8%；注意与"风格建议3/千字"是两回事）
    'cluster_paras': 1,     # 真人 p97≈0~1.35%，扎堆≥1段即罕见
    # ── Tier4 新增特征（calibrate_ai_tells.py，700章真人校准）──
    'local_repeat_per_1k': 13.5,  # 同一短语400字窗口内重复≥3次，p95=13.7 p97=15.2
    'tier4_weight': 8,       # 单条记分（低于 tier3 的 12）——新特征宁可低估不可误伤
    'tier4_on': True,        # 总开关：设 False 即回退到旧版评分
    # ── 2026-09-01 跨模型探针新增（_calib_new_rules.py，80段真人校准）──
    'simile_lead_max': 3,    # 单个喻体引导词全章最多用几次：p95=3 p99=4 max=4
}


# 喻体引导词（不含"似乎"——那是模糊语不是比喻；不含"像…一样"——归"明喻过密"管）
SIMILE_LEADS = ['如同', '仿佛', '宛如', '好似', '犹如', '恰似']


def simile_lead_repeat(t):
    """喻体引导词【单字机械重复】——返回 (用词, 次数)。

    与"明喻过密"（密度制）互补：密度制看比喻总量，这里看**同一个引导词被反复使用**。
    真人写作会换说法，AI 会死磕同一个词。
    实测（_calib_new_rules.py，80 段真人 / 4 段 GLM 原生输出）：
        真人 p95=3  p99=4  max=4
        AI  : glm-4.5-flash 玄幻"如同"11次、都市5次；glm-4.5-air 玄幻9次、都市3次
    """
    best, bn = '', 0
    for w in SIMILE_LEADS:
        c = (t or '').count(w)
        if c > bn:
            best, bn = w, c
    return best, bn


def _paras(text):
    return [p.strip() for p in re.split(r'\n+', text) if p.strip()]


def score_text(text, threshold=40):
    v = []

    def add(rule, tier, count, advice):
        v.append({'rule': rule, 'tier': tier, 'count': count, 'advice': advice})

    paras = _paras(text)
    n_chars = max(len(text.replace('\n', '')), 1)
    per_1k = lambda c: c / n_chars * 1000

    # Tier1
    for pat, name in TIER1:
        hits = re.findall(pat, text)
        if hits:
            add(name, 1, len(hits), f'删除或改写“{name}”类套话（{len(hits)}处），换成具体动作或细节')

    # Tier2 同段扎堆
    for pat, name in TIER2:
        clustered = sum(1 for p in paras if len(re.findall(pat, p)) >= 2)
        if clustered >= TH['cluster_paras']:
            add(name, 2, clustered, f'{clustered}个段落里"{name}"扎堆（真人语料几乎不出现），每段最多留1个')

    # 三连排比（密度制）
    san = len(SANLIAN.findall(text))
    if per_1k(san) > TH['sanlian_per_1k']:
        add('三连排比过密', 2, san, f'同构三连短句{per_1k(san):.1f}/千字（真人基线3.7），拆掉同构、改为不对称表达')

    # Tier3 校准密度线
    dashes = per_1k(text.count('——'))
    if dashes > TH['dash_per_1k']:
        add('破折号过密', 3, text.count('——'), f'破折号{dashes:.1f}/千字（真人p90=1.45），改逗号/省略号/断句')

    w = len(re.findall(TIER3_WORDS, text))
    if w / n_chars * 1000 > 6:
        add('高频虚词', 3, w, '“重要/关键/核心/瞬间/命运”密度超标，删一半或换成具体信息')

    ex = per_1k(text.count('！'))
    if ex > TH['exclaim_per_1k']:
        add('感叹号超标', 3, text.count('！'), f'感叹号{ex:.1f}/千字（基线3.26），压到3/千字内')

    dlg = [p for p in paras if '\u201c' in p or '「' in p]
    if len(dlg) >= 4:
        tagged = sum(1 for p in dlg if DIALOG_TAG.search(p))
        if tagged / len(dlg) > 0.6:
            add('对话标签过密', 3, tagged,
                f'{len(dlg)}个对话段{tagged}个带"说道/问道"标签，删掉大半，靠称呼与内容区分')

    sl = [len(x) for x in re.split(r'[。！？!?…]+', text) if x.strip()]
    if len(sl) >= 10:
        m = sum(sl) / len(sl)
        cv = (sum((x - m) ** 2 for x in sl) / len(sl)) ** 0.5 / m if m else 0
        if cv < 0.35:
            add('句长节奏过齐', 3, round(cv, 2), f'句长变异系数{cv:.2f}<0.35（AI式等长），穿插短句和长句')

    # 结构
    long_pct = sum(1 for p in paras if len(p) > 100) / max(len(paras), 1) * 100
    if long_pct > TH['long_para_pct']:
        add('段落超长', 3, sum(1 for p in paras if len(p) > 100),
            f'{long_pct:.0f}%段落超100字（真人p90=4.2%），拆成一两句一段')

    run = mx = 0
    for p in paras:
        run = run + 1 if len(p) <= 10 else 0
        mx = max(mx, run)
    if mx > TH['run_short']:
        add('超短段连用', 3, mx, f'≤10字超短段连用{mx}个（真人p90=3），连用不超3个后插30~60字叙述段')

    if n_chars > 1200 and paras:
        short_ratio = sum(1 for p in paras if len(p) <= 30) / len(paras) * 100
        if short_ratio > 90:
            add('段落过碎（一行体）', 3, round(short_ratio),
                f'{short_ratio:.0f}%的段落≤30字（语料基线56%）——打斗/环境/心理段请用3~5句的大段落（60~120字），长短交错')

    # Tier4 新增特征（密度制，阈值取真人 p97）
    if TH.get('tier4_on', True):
        for pat, name, th, advice in TIER4:
            c = len(re.findall(pat, text))
            d = per_1k(c)
            if d > th:
                add(name, 4, c, advice.format(d))
        lpr = local_phrase_repeat(text)
        if per_1k(lpr) > TH['local_repeat_per_1k']:
            add('局部短语重复', 4, lpr,
                f'同一短语在400字内反复出现{lpr}处（真人p97≈15/千字）。'
                f'典型如"紫色的天光"300字内出现4次——换词、合并或删掉重复的那几处')
        # 喻体引导词单字重复（计数制，非密度制——与"明喻过密"互补）
        _lead, _lead_n = simile_lead_repeat(text)
        if _lead_n > TH['simile_lead_max']:
            add('喻体引导词重复', 4, _lead_n,
                f'"{_lead}"在全文用了{_lead_n}次（真人p95={TH["simile_lead_max"]}次、max=4次）。'
                f'同一个比喻引导词被反复使用是AI最典型的机械特征——'
                f'保留1~2处，其余改成直接陈述或换个说法')

    tail = ''.join(paras[-2:])
    if re.search(r'(总之|或许这就是|也许这就是|仿佛在诉说|似乎在告诉)', tail):
        add('总结式收尾', 1, 1, '结尾在升华点题，语料钩子靠危机/情绪悬置，不点破主题')

    if paras and paras[-1].rstrip().endswith(('？', '?')):
        add('问号钩子', 3, 1, '问句收尾（语料仅3.3%），改成危机/反转/情绪悬置')

    score = 0
    for x in v:
        if x['tier'] == 1:
            score += 10 * x['count']
        elif x['tier'] == 2:
            score += 12 * min(x['count'], 4)
        elif x['tier'] == 3:
            score += 12
        else:
            score += TH['tier4_weight']
    score = min(100, score)

    return {
        'score': score,
        'passed': score <= threshold,
        'violations': sorted(v, key=lambda x: -x['tier']),
        'metrics': {
            'chars': n_chars, 'paras': len(paras),
            'avg_para': round(n_chars / max(len(paras), 1), 1),
            'dialog_pct': round(len(dlg) / max(len(paras), 1) * 100, 1),
        },
    }


def dice(a, b):
    """内容保真度：字符二元组 Dice（标点空白不计），改写回退红线 0.55"""
    def bg(s):
        s = re.sub(r'[\s，。！？!?\u201c\u201d…：；、（）()——]', '', s)
        return set(s[i:i+2] for i in range(len(s) - 1))
    A, B = bg(a), bg(b)
    if not A or not B:
        return 0.0
    return round(2 * len(A & B) / (len(A) + len(B)), 3)


def strip_wrapping(t):
    """去掉模型输出里的代码围栏和引导语，避免污染评分与命中校验"""
    t = (t or '').strip()
    if t.startswith('```'):
        t = re.sub(r'^```[a-zA-Z]*\s*', '', t)
        t = re.sub(r'```\s*$', '', t).strip()
    t = re.sub(r'^(好的[，,！!]?|当然[，,！!]?|以下是[^：:\n]{0,20}[：:]?|这是修改[^：:\n]{0,20}[：:]?|修改后的[^：:\n]{0,15}[：:]?)\s*', '', t)
    return t.strip()


def para_coverage(orig, new, hit_at=0.55):
    """逐段对齐保真度：原文每个段落在重写稿中找最相似段，Dice≥0.55 算命中。
    返回命中率(0~1)。比全文 Dice 严格得多——剧情/人物被改的段会显著掉命中。"""
    A = _paras(orig)
    B = _paras(new)
    if not A:
        return 1.0
    if not B:
        return 0.0
    hit = sum(1 for a in A if max((dice(a, b) for b in B), default=0) >= hit_at)
    return round(hit / len(A), 3)


def bert_score(text):
    """可选：本地 BERT 检测器（models/ai-detector/ 放入模型即自动启用）"""
    import os
    d = 'E:/agent文章内容/models/ai-detector'
    if not os.path.isdir(d):
        return None
    global _bert
    try:
        if '_bert' not in globals():
            from transformers import pipeline
            _bert = pipeline('text-classification', model=d, truncation=True, max_length=512)
        return _bert(text[:2000])[0]
    except Exception:
        return None


if __name__ == '__main__':
    import sys, io, json
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    argv = list(sys.argv[1:])
    genre = None
    if '--genre' in argv:
        i = argv.index('--genre')
        genre = argv[i + 1]
        del argv[i:i + 2]
    t = open(argv[0], encoding='utf-8').read() if argv else sys.stdin.read()
    if genre == 'comedy':
        # 体裁豁免（v0.28 作者裁定）：喜剧的拟声/夸张标点密度天然高于网文p90，
        # 仅放宽破折号与感叹号两档密度阈值×1.5，其余规则不动；使用须在质检文件记录。
        TH['dash_per_1k'] *= 1.5
        TH['exclaim_per_1k'] *= 1.5
    print(json.dumps(score_text(t), ensure_ascii=False, indent=1))
