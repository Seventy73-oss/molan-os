# -*- coding: utf-8 -*-
"""
AI 味新特征校准（阈值从真人语料分布反推，与 ai_flavor_score.py 的 TH 同一方法）

用法： python calibrate_ai_tells.py [抽样章数，默认800]

输出每个候选特征在真人语料上的 p50/p90/p95/p97/p99，供设定报警线。
原则（沿用既有约定）：阈值取真人分布的 p90~p97；
      p97 仍为 0 的特征 = 真人几乎不用 → 可作"一票命中/低频即报"。
"""
import json, re, sys
from collections import defaultdict

# ── 候选特征（正则即最终检测式，改动需同步 ai_flavor_score.py）──
PAT = {
    '明喻密度':     r'像[^，。！？]{0,10}一样|仿佛|似乎|如同|宛如|好似|犹如|似的',
    '占位模糊句':   r'仿佛在(预示|暗示|诉说|告诉|等待|宣告|提醒|召唤)|似乎有什么|好像有什么|仿佛有什么|'
                    r'似乎在(暗示|告诉|诉说|等待)|像是有什么',
    '身体语言套路': r'紧绷的肩膀|攥紧(了)?(拳头|拳)|指甲.{0,6}掐进|深吸一口气|深吸了口气|咬了咬牙|皱了皱眉|'
                    r'握紧(了)?(拳头|拳)|拳头.{0,4}咯吱|攥着拳',
    '眼神神色':     r'眼神|神色|神情|目光[里中]|眸[子里中]',
    '不禁不由得':   r'不禁|不由得|情不自禁|忍不出',
    '轻缓副词':     r'缓缓|轻轻|微微|悄悄|慢慢|徐徐',
    '对称有的句式': r'有的[^，。！？]{1,12}[，,][^。！？]{0,24}有的',
    '感官堆砌':     r'(空气|四周|周围|空气中)(中)?(弥漫|充斥|飘荡|荡漾|弥漫开)着',
    '所到之处类':   r'所到之处|无一例外|与此同时|不知为何|说不清道不明',
}


def local_phrase_repeat(t, win=400, minc=3):
    """局部短语重复：同一 3 字片段在 win 字窗口内出现 >= minc 次。
    例：'紫色的天光' 在 300 字内出现 4 次 → 命中。全局重复率无效（网文本身重复多），必须限定窗口。"""
    s = re.sub(r'[\s，。！？!?…：；:、“”‘’（）()《》]', '', t)
    if len(s) < 200:
        return 0
    pos = defaultdict(list)
    for i in range(len(s) - 2):
        pos[s[i:i + 3]].append(i)
    n = 0
    for _g, ps in pos.items():
        if len(ps) < minc:
            continue
        for j in range(len(ps) - minc + 1):
            if ps[j + minc - 1] - ps[j] < win:
                n += 1
                break
    return n


def load_human(n):
    out = []
    with open('corpus/train/webnovel_train_clean.jsonl', encoding='utf-8') as f:
        for i, l in enumerate(f):
            if i >= n:
                break
            out.append(json.loads(l).get('text', ''))
    return out


def pct(sorted_v, p):
    return sorted_v[min(int(len(sorted_v) * p), len(sorted_v) - 1)]


SANLIAN = re.compile(r'[^，。！？\n]{1,8}[，,][^，。！？\n]{1,8}[，,][^，。！？\n]{1,8}[。！？]')
TIER3_WORDS = r'重要|关键|核心|瞬间|刹那|命运'
DIALOG_TAG = re.compile(r'(说道|问道|答道|喝道|沉声道|开口道|冷声道)')


def _paras(t):
    return [p.strip() for p in re.split(r'\n+', t) if p.strip()]


def audit_existing(texts, cur):
    """复核现有阈值：单章口径下的实测触发率 vs 期望(≤10%)"""
    n = len(texts)
    keys = ('dash_per_1k', 'exclaim_per_1k', 'sanlian_per_1k', 'long_para_pct', 'run_short',
            'tier3_words(固定6)', 'short_ratio(固定90)', 'dialog_tag(固定0.6)', 'cv<0.35(固定)')
    hit = {k: 0 for k in keys}
    dist = {k: [] for k in ('dash_per_1k', 'exclaim_per_1k', 'sanlian_per_1k', 'long_para_pct')}
    for t in texts:
        _ln = max(len(t.replace('\n', '')), 1)
        _k1 = lambda c: c / _ln * 1000
        dist['dash_per_1k'].append(_k1(t.count('——')))
        dist['exclaim_per_1k'].append(_k1(t.count('！')))
        dist['sanlian_per_1k'].append(_k1(len(SANLIAN.findall(t))))
        paras = _paras(t)
        ln = max(len(t.replace('\n', '')), 1)
        k1 = lambda c: c / ln * 1000
        if k1(t.count('——')) > cur['dash_per_1k']:                       hit['dash_per_1k'] += 1
        if k1(t.count('！')) > cur['exclaim_per_1k']:                     hit['exclaim_per_1k'] += 1
        if k1(len(SANLIAN.findall(t))) > cur['sanlian_per_1k']:           hit['sanlian_per_1k'] += 1
        if k1(len(re.findall(TIER3_WORDS, t))) > 6:                       hit['tier3_words(固定6)'] += 1
        if paras:
            lp = sum(1 for p in paras if len(p) > 100) / len(paras) * 100
            dist['long_para_pct'].append(lp)
            if lp > cur['long_para_pct']:                                 hit['long_para_pct'] += 1
            run = mx = 0
            for p in paras:
                run = run + 1 if len(p) <= 10 else 0
                mx = max(mx, run)
            if mx > cur['run_short']:                                     hit['run_short'] += 1
            if ln > 1200:
                sr = sum(1 for p in paras if len(p) <= 30) / len(paras) * 100
                if sr > 90:                                               hit['short_ratio(固定90)'] += 1
            dlg = [p for p in paras if '\u201c' in p or '「' in p]
            if len(dlg) >= 4:
                tg = sum(1 for p in dlg if DIALOG_TAG.search(p))
                if tg / len(dlg) > 0.6:                                   hit['dialog_tag(固定0.6)'] += 1
        sl = [len(x) for x in re.split(r'[。！？!?…]+', t) if x.strip()]
        if len(sl) >= 10:
            m = sum(sl) / len(sl)
            cv = (sum((x - m) ** 2 for x in sl) / len(sl)) ** 0.5 / m if m else 0
            if cv < 0.35:                                                 hit['cv<0.35(固定)'] += 1

    print(f'=== 现有阈值复核：单章口径实测触发率（n={n}）===')
    print(f'{"阈值项":<22}{"当前值":>9}{"触发率":>9}   判定')
    print('-' * 58)
    for k, c in hit.items():
        r = c / n * 100
        tag = 'OK' if r <= 10 else ('偏高' if r <= 20 else '误伤严重')
        cur_v = str(cur.get(k, '—')) if k in cur else k.split('(')[1].rstrip(')') if '(' in k else '—'
        print(f'{k:<22}{cur_v:>9}{r:>8.1f}%   {tag}')

    print()
    print('=== 单章分布 → 重设阈值（取 p97 则单条误伤约 3%）===')
    print(f'{"阈值项":<20}{"p90":>8}{"p95":>8}{"p97":>8}{"p99":>8}{"当前":>9}{"建议p97":>10}')
    print('-' * 72)
    for k, v in dist.items():
        v = sorted(v)
        p90, p95, p97, p99 = pct(v, .90), pct(v, .95), pct(v, .97), pct(v, .99)
        print(f'{k:<20}{p90:>8.2f}{p95:>8.2f}{p97:>8.2f}{p99:>8.2f}{cur.get(k, 0):>9}{round(p97, 1):>10}')


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 800
    texts = [t for t in load_human(n) if len(t) > 500]
    print(f'真人语料样本：{len(texts)} 章（取自 corpus/train/webnovel_train_clean.jsonl）')

    # 一、现有阈值复核
    try:
        import ai_flavor_score as AFS
        audit_existing(texts, dict(AFS.TH))
    except Exception as e:
        print('（跳过现有阈值复核：', e, '）')

    # 二、新增候选特征分布
    print()
    res = {k: [] for k in PAT}
    res['局部短语重复'] = []
    for t in texts:
        ln = max(len(t), 1)
        for k, p in PAT.items():
            res[k].append(len(re.findall(p, t)) / ln * 1000)
        res['局部短语重复'].append(local_phrase_repeat(t) / ln * 1000)

    print(f'{"新增特征":<16}{"p50":>7}{"p90":>7}{"p95":>7}{"p97":>7}{"p99":>7}   建议阈值')
    print('-' * 66)
    for k, v in res.items():
        v = sorted(v)
        p90, p95, p97, p99 = pct(v, .90), pct(v, .95), pct(v, .97), pct(v, .99)
        if p97 <= 0.01:
            tip = '真人几乎不用 → 出现即报'
        elif p97 < 1.0:
            tip = f'建议 {p97:.2f}（低频特征，宁紧）'
        else:
            tip = f'建议 {p95:.2f}（p95）或 {p97:.2f}（p97）'
        print(f'{k:<16}{pct(v,.5):>7.2f}{p90:>7.2f}{p95:>7.2f}{p97:>7.2f}{p99:>7.2f}   {tip}')


if __name__ == '__main__':
    main()
