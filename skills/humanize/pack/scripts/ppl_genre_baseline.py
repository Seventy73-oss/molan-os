#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""M3 · 分题材困惑度基线（测量工具）

输入：`style_metrics.py` 跑出的整书困惑度 JSON（`08_统计基线/ppl_真人133本.json`）
      ＋ 题材标签（`08_统计基线/题材标签_133本.json`）
输出：`08_统计基线/ppl_分题材_133本.json`（每档 perplexity / nll_std 的 p10/p25/med/p75）

⚠️ 口径说明：困惑度对长度敏感。整书 JSON 里每条是**每本前 4000 字**的打分
（`PPL.score(max_chars=4000)`），与单章 2500~4500 字量级相当，故可直接用于逐章门。
"""
import argparse
import io
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def pct(v, p):
    v = sorted(v)
    if not v:
        return 0.0
    i = min(len(v) - 1, max(0, int(round((len(v) - 1) * p))))
    return v[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ppl', default='08_统计基线/ppl_真人133本.json')
    ap.add_argument('--genres', default='08_统计基线/题材标签_133本.json')
    ap.add_argument('--json', default='08_统计基线/ppl_分题材_133本.json')
    args = ap.parse_args()

    d = json.load(io.open(args.ppl, encoding='utf-8'))
    g = json.load(io.open(args.genres, encoding='utf-8'))
    gmap = {e['book']: e.get('genre', '未标') for e in g}
    groups = {}
    for r in d['rows']:
        groups.setdefault(gmap.get(r['label'], '未标'), []).append(r)

    out = {'source': args.ppl, 'genres': {}}
    for gg, items in sorted(groups.items(), key=lambda x: -len(x[1])):
        blk = {'n': len(items)}
        for k in ('perplexity', 'nll_mean', 'nll_std', 'burstiness'):
            v = [x[k] for x in items if x.get(k) is not None]
            if not v:
                continue
            blk[k] = {'min': round(min(v), 3), 'p10': round(pct(v, .10), 3),
                      'p25': round(pct(v, .25), 3), 'med': round(pct(v, .50), 3),
                      'p75': round(pct(v, .75), 3), 'max': round(max(v), 3)}
        out['genres'][gg] = blk
    allv = {}
    for k in ('perplexity', 'nll_mean', 'nll_std', 'burstiness'):
        v = [x[k] for x in d['rows'] if x.get(k) is not None]
        allv[k] = {'min': round(min(v), 3), 'p10': round(pct(v, .10), 3),
                   'p25': round(pct(v, .25), 3), 'med': round(pct(v, .50), 3),
                   'p75': round(pct(v, .75), 3), 'max': round(max(v), 3)}
    out['all'] = {'n': len(d['rows']), **allv}

    io.open(args.json, 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=1))
    print('分题材困惑度基线：')
    for gg, blk in out['genres'].items():
        if blk['n'] < 3:
            continue
        p = blk['perplexity']
        ns = blk['nll_std']
        print('  %-10s n=%3d  ppl p10 %6.2f med %6.2f | nll_std p10 %5.3f' % (
            gg, blk['n'], p['p10'], p['med'], ns['p10']))
    print('→ %s' % args.json)
    return 0


if __name__ == '__main__':
    sys.exit(main())
