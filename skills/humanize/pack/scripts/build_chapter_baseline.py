#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""章级基线构建器（测量工具，不是门）

为什么需要它：
  门7 要**逐章**判定，而每章 2500~4500 字。用「每本前 20 万字」的整书分布当章级阈值
  是**长度错配**——样本越长，情感极性 sd、杂讯等指标越极端（实测：3000 字零杂讯 59%，
  20 万字零杂讯只有 2%）。用错配阈值会把正常章判成异常，也会漏掉真异常。

做法：
  每本真人书取 5 个窗口（偏移 0 / 1万 / 2万 / 4万 / 8 万字处，各 3000 字），
  汇总成「章级样本池」（133 本 × 5 窗口 ≈ 665 个章级样本），算分位数。

输出：08_统计基线/题材基线_章级_133本.json

用法：
  python 03_评分与校准/build_chapter_baseline.py \
      --corpus "04_语料/真人语料_网文133本" \
      --genres "08_统计基线/题材标签_133本.json" \
      --window 3000 --offsets 0,10000,20000,40000,80000 \
      --json "08_统计基线/题材基线_章级_133本.json"
"""
import argparse
import glob
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _metrics import read_text, probe  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

METRICS = [
    ('smean', '均句长', 2), ('ssd', '句长sd', 2),
    ('pmean', '均段长', 2), ('psd', '段长sd', 2),
    ('dlg_pct', '对白段%', 1), ('env2_pct', '环境段%严格', 1),
    ('env_pct', '环境段%', 1), ('envsent_pct', '环境句%', 1),
    ('said_kilo', '说族/千字', 2), ('simile_kilo', '明喻/千字', 2),
    ('conn_kilo', '承接词AI/千字', 2), ('conn_nat_kilo', '承接词自然/千字', 2),
    ('conn_fn_kilo', '单字虚词/千字', 2), ('head_rep', '句首重复率', 3),
    ('pol_sd', '情感极性sd', 3), ('pol_turns_kilo', '情感转折/千字', 2),
    ('pol_pos_pct', '正向句%', 1), ('pol_neg_pct', '负向句%', 1),
]


def pct(vals, p):
    vals = sorted(vals)
    if not vals:
        return 0.0
    i = min(len(vals) - 1, max(0, int(round((len(vals) - 1) * p))))
    return vals[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', required=True)
    ap.add_argument('--genres', default=None)
    ap.add_argument('--window', type=int, default=3000)
    ap.add_argument('--offsets', default='0,10000,20000,40000,80000')
    ap.add_argument('--json', required=True)
    ap.add_argument('--md', default=None)
    args = ap.parse_args()

    offsets = [int(x) for x in args.offsets.split(',') if x.strip()]
    books = sorted(glob.glob(os.path.join(args.corpus, '*.txt')))
    gmap = {}
    if args.genres and os.path.exists(args.genres):
        for e in json.load(io.open(args.genres, encoding='utf-8')):
            gmap[e['book']] = e.get('genre', '未标')

    samples = []
    for b in books:
        text = read_text(b)
        if len(text) < args.window:
            continue
        name = os.path.basename(b)
        for off in offsets:
            seg = text[off:off + args.window]
            if len(seg) < args.window // 2:
                continue
            r = probe(seg, '%s@%d' % (name, off))
            r['book'] = name
            r['genre'] = gmap.get(name, '未标')
            samples.append(r)

    def summarize(items):
        d = {'n': len(items)}
        for k, lab, nd in METRICS:
            v = [x[k] for x in items]
            d[k] = {'label': lab,
                    'min': round(min(v), nd), 'p10': round(pct(v, .10), nd),
                    'p25': round(pct(v, .25), nd), 'med': round(pct(v, .50), nd),
                    'p75': round(pct(v, .75), nd), 'p90': round(pct(v, .90), nd),
                    'max': round(max(v), nd)}
        d['zero_noise_pct'] = round(
            100.0 * sum(1 for x in items if sum(x['noise'].values()) == 0) / max(len(items), 1), 1)
        return d

    out = {
        'corpus': args.corpus, 'n_books': len(books), 'window': args.window,
        'offsets': offsets, 'n_samples': len(samples),
        'note': '章级基线：每本取多个 3000 字窗口汇总；逐章门7 用这个，不用整书 20 万字基线',
        'all': summarize(samples), 'genres': {},
    }
    groups = {}
    for s in samples:
        groups.setdefault(s['genre'], []).append(s)
    for g, items in sorted(groups.items(), key=lambda x: -len(x[1])):
        if len(items) >= 12:
            out['genres'][g] = summarize(items)

    os.makedirs(os.path.dirname(args.json) or '.', exist_ok=True)
    io.open(args.json, 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=1))
    print('章级样本池：%d 本 × %d 窗口 = %d 个样本（窗口 %d 字）'
          % (len(books), len(offsets), len(samples), args.window))
    print('→ %s' % args.json)

    if args.md:
        lines = ['| 指标 | min | p25 | med | p75 | max | 零杂讯% |', '|---|---|---|---|---|---|---|']
        for k, lab, nd in METRICS:
            v = out['all'][k]
            f = '{:.%df}' % nd
            lines.append('| %s | %s | %s | %s | %s | %s | — |' % (
                lab, f.format(v['min']), f.format(v['p25']), f.format(v['med']),
                f.format(v['p75']), f.format(v['max'])))
        lines.append('| 零杂讯章% | — | — | — | — | — | {:.1f}% |'.format(
            out['all']['zero_noise_pct']))
        io.open(args.md, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
        print('→ %s' % args.md)
    return 0


if __name__ == '__main__':
    sys.exit(main())
