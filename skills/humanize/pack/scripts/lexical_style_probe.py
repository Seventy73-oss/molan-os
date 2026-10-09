# -*- coding: utf-8 -*-
"""词法与修辞诊断（作者 2026-09-10 反馈量化）

作者指出：
  ① 太爱用比喻，八大修辞只用上明喻一个
  ② 单字癖：能两字描述的都压成单字（嚼/咽/顶/递）
  ③ 垂直领域文风、情绪色彩系统似乎没调用

本脚本量化前两项 + 情绪词多样性，对照真人西幻档：
  · 单字动词占比（jieba 词性 v*）
  · 修辞种类命中（明喻/暗喻/反问/设问/夸张/排比/对偶/拟人粗判）
  · 情绪词种类数与 TTR
"""
import glob
import io
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, '03_评分与校准')
from _metrics import POS_WORDS, NEG_WORDS  # noqa: E402
import jieba.posseg as pseg  # noqa: E402

# ── 修辞识别（粗粒度，只统计可自动识别的）──────────────────────────
RHE = {
    '明喻': re.compile(r'(像|仿佛|如同|似的|宛如|好像|犹如|恰似|好似)'),
    '暗喻': re.compile(r'(?:是|成了|变成|化为)[^，。！？]{0,12}(?:的|一样)'),
    '反问': re.compile(r'(难道|岂(?!有此理)|何尝|何必|怎么会|怎能|不[是就]?…?吗)'),
    '设问': re.compile(r'[？?]'),
    '夸张': re.compile(r'(无比|极(?:其|为)|要命|得要死|千|万|成百上千|震天|惊天|铺天盖地)'),
    '对偶': re.compile(r'[^，。！？]{2,6}[，,][^，。！？]{2,6}[，,][^，。！？]{2,6}[。！？]'),
    '排比': re.compile(r'[^，。！？\n]{1,10}[，,][^，。！？\n]{1,10}[，,][^，。！？\n]{1,10}[，,]'),
    '拟人': re.compile(r'(?:风|雨|雪|云|月|光|火|树|草|石头|骨头|影子|声音)[^，。]{0,6}'
                      r'(?:笑|哭|喘|睡|醒|记得|忘了|愿意|不肯|认得|听着|看着|等着)'),
}


def stats(text, name):
    nows = re.sub(r'\s', '', text)
    n = len(nows) or 1
    # 词性
    words = [(w.word, w.flag) for w in pseg.cut(text)]
    verbs = [w for w, f in words if f.startswith('v')]
    nouns = [w for w, f in words if f.startswith('n')]
    v1 = [w for w in verbs if len(w) == 1]
    n1 = [w for w in nouns if len(w) == 1]
    # 情绪词
    emo = [w for w in POS_WORDS + NEG_WORDS if w in text]
    # 修辞
    rhe = {k: len(p.findall(text)) for k, p in RHE.items()}
    return {
        'name': name, 'chars': n,
        'verbs': len(verbs), 'v1_ratio': 100.0 * len(v1) / max(len(verbs), 1),
        'v1_kilo': 1000.0 * len(v1) / n,
        'nouns': len(nouns), 'n1_ratio': 100.0 * len(n1) / max(len(nouns), 1),
        'emo_kinds': len(emo), 'emo_kilo': 1000.0 * sum(text.count(w) for w in emo) / n,
        'rhe': rhe, 'rhe_kinds': sum(1 for v in rhe.values() if v > 0),
        'top_v1': [w for w in v1 if len(w) == 1][:0],
    }


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, max(0, int(round((len(v) - 1) * p))))]


# 我们
rows = []
for f in sorted(glob.glob('15_新书_骨语者/chapters/*.md')):
    t = io.open(f, encoding='utf-8').read()
    rows.append(stats(t, os.path.basename(f)))

# 真人西幻
genres = {}
for e in json.load(io.open('08_统计基线/题材标签_133本.json', encoding='utf-8')):
    genres[e['book']] = e.get('genre', '')
corpus = []
for b in [b for b, g in genres.items() if g == '西幻/异世界']:
    p = os.path.join('04_语料/真人语料_网文133本', b)
    if not os.path.exists(p):
        continue
    try:
        t = io.open(p, encoding='utf-8').read()
    except Exception:
        t = io.open(p, encoding='gb18030', errors='replace').read()
    corpus.append(stats(t[:100000], b[:20]))

print('=' * 92)
print('词法与修辞诊断（真人西幻 n=%d，每本前 10 万字；我们 4 章全章）' % len(corpus))
print('=' * 92)
print('%-14s %8s %8s %8s %8s %8s %8s' % ('样本', '单字动词%', '单字名%', '情绪词种', '情绪词/千', '修辞种', '字数'))
print('-' * 92)
for k, lab in [('v1_ratio', '单字动词%')]:
    pass
print('%-14s %8.1f %8.1f %8.0f %8.2f %8.1f' % (
    '真人 p25', pct([c['v1_ratio'] for c in corpus], .25),
    pct([c['n1_ratio'] for c in corpus], .25),
    pct([c['emo_kinds'] for c in corpus], .25),
    pct([c['emo_kilo'] for c in corpus], .25),
    pct([c['rhe_kinds'] for c in corpus], .25)))
print('%-14s %8.1f %8.1f %8.0f %8.2f %8.1f' % (
    '真人 p75', pct([c['v1_ratio'] for c in corpus], .75),
    pct([c['n1_ratio'] for c in corpus], .75),
    pct([c['emo_kinds'] for c in corpus], .75),
    pct([c['emo_kilo'] for c in corpus], .75),
    pct([c['rhe_kinds'] for c in corpus], .75)))
for r in rows:
    print('%-14s %8.1f %8.1f %8.0f %8.2f %8.1f %8d' % (
        r['name'][:13], r['v1_ratio'], r['n1_ratio'], r['emo_kinds'],
        r['emo_kilo'], r['rhe_kinds'], r['chars']))

print('\n=== 修辞命中明细（次数）===')
print('%-14s %s' % ('样本', ' '.join('%6s' % k for k in RHE)))
for r in rows:
    print('%-14s %s' % (r['name'][:13], ' '.join('%6d' % r['rhe'][k] for k in RHE)))
med = {k: pct([c['rhe'][k] for c in corpus], .5) for k in RHE}
print('%-14s %s   ← 真人 med' % ('真人 med', ' '.join('%6.1f' % med[k] for k in RHE)))
