#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""M2 · 承接词词表实测（测量工具，不是门）

目的：现有 CONNECT 词表只有 11 个 AI 味词（因此/所以/然而/于是…），我们全禁用 →
      承接词密度 0.0/千字，落在真人档外。但"真人到底用哪些词"从未测过。
      本脚本用 133 本真人语料逐个候选词统计，产出**可用白名单**。

输出：
  · 每个候选词：总次数、出现本书数（覆盖率）、整体密度、西幻档覆盖率
  · 我们（--files）的命中情况
  · JSON 供 build_context.py / 门7 读取

用法：
  python 03_评分与校准/conn_words.py --corpus "04_语料/真人语料_网文133本" \
      --genres "08_统计基线/题材标签_133本.json" \
      --files "15_新书_骨语者/chapters/*.md" --json "08_统计基线/承接词词表_133本.json"
"""
import argparse
import glob
import io
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

SAMPLE_CHARS = 200000   # 与 narrative_probe 口径一致：每本前 20 万字

# ── 候选词表（分四类；只收多字词，单字虚词如"却/更"另计且不入门）────────────
CATEGORIES = {
    '因果': ['因此', '所以', '于是', '因而', '故而', '由此', '以致', '从而', '进而',
             '正因为', '怪不得', '难怪', '结果'],
    '转折': ['然而', '但是', '可是', '不过', '只是', '偏偏', '反而', '反倒',
             '虽说', '尽管', '虽然'],
    '顺承': ['后来', '随后', '接着', '然后', '继而', '跟着', '接下来', '之后',
             '过后', '旋即', '随即', '当即', '这才', '于是乎'],
    '时间衔接': ['半晌', '过了一会儿', '过了会儿', '隔了会儿', '没多久', '不多时',
                 '等到', '片刻后', '第二天', '当晚', '那天', '一炷香', '半刻',
                 '这一夜', '那晚', '隔天', '回头', '转眼'],
    '递进补充': ['而且', '况且', '何况', '再说', '此外', '另外', '同时',
                 '与此同时', '甚至', '尤其', '再者'],
    '总结让步': ['总之', '反正', '说到底', '归根结底', '无论如何', '好歹',
                 '不管怎么说', '至少'],
    '单字虚词': ['却', '更', '再', '便', '就', '才'],
}

WORDS = [(w, cat) for cat, ws in CATEGORIES.items() for w in ws]
WORD_LIST = [w for w, _ in WORDS]
CAT_OF = dict(WORDS)


def read_text(path):
    try:
        return io.open(path, encoding='utf-8').read()
    except Exception:
        return io.open(path, encoding='gb18030', errors='replace').read()


def norm_len(s):
    return len(re.sub(r'\s', '', s))


def count_words(text):
    return {w: len(re.findall(re.escape(w), text)) for w in WORD_LIST}


def pct(vals, p):
    vals = sorted(vals)
    if not vals:
        return 0
    i = min(len(vals) - 1, max(0, int(round((len(vals) - 1) * p))))
    return vals[i]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', required=True)
    ap.add_argument('--genres', default=None, help='题材标签 JSON（分档统计）')
    ap.add_argument('--genre', default='西幻/异世界', help='要重点看的题材档')
    ap.add_argument('--files', default=None, help='我们的稿子（通配）')
    ap.add_argument('--json', default=None)
    ap.add_argument('--top', type=int, default=40)
    args = ap.parse_args()

    books = sorted(glob.glob(os.path.join(args.corpus, '*.txt')))
    if not books:
        print('no corpus', file=sys.stderr)
        return 1
    gmap = {}
    if args.genres and os.path.exists(args.genres):
        gj = json.load(io.open(args.genres, encoding='utf-8'))
        if isinstance(gj, list):          # [{"book":..., "genre":...}, ...]
            gmap = {e['book']: e.get('genre', '') for e in gj if isinstance(e, dict)}
        else:
            gmap = gj.get('labels') or gj.get('books') or gj

    per_book = []
    for b in books:
        t = read_text(b)[:SAMPLE_CHARS]
        chars = norm_len(t) or 1
        cnt = count_words(t)
        name = os.path.basename(b)
        per_book.append({
            'name': name, 'chars': chars, 'cnt': cnt,
            'kilo': {w: 1000.0 * c / chars for w, c in cnt.items()},
            'genre': gmap.get(name) or gmap.get(os.path.splitext(name)[0]) or '',
        })

    total_chars = sum(p['chars'] for p in per_book)
    rows = []
    for w, cat in WORDS:
        books_with = sum(1 for p in per_book if p['cnt'][w] > 0)
        total = sum(p['cnt'][w] for p in per_book)
        dens = [p['kilo'][w] for p in per_book if p['cnt'][w] > 0]
        xh = [p for p in per_book if p['genre'] == args.genre]
        xh_with = sum(1 for p in xh if p['cnt'][w] > 0)
        rows.append({
            'word': w, 'cat': cat, 'total': total,
            'books_with': books_with,
            'coverage': books_with / len(per_book),
            'kilo_overall': 1000.0 * total / total_chars,
            'kilo_med_used': pct(dens, .5),
            'kilo_p75_used': pct(dens, .75),
            'genre_n': len(xh), 'genre_with': xh_with,
            'genre_coverage': (xh_with / len(xh)) if xh else 0,
        })
    rows.sort(key=lambda r: (-r['coverage'], -r['kilo_overall']))

    print('=' * 88)
    print(f'M2 · 承接词词表实测（真人 {len(per_book)} 本，每本前 {SAMPLE_CHARS//10000} 万字，'
          f'共 {total_chars/10000:.0f} 万字）')
    print('=' * 88)
    print(f"{'词':<8}{'类':<6}{'总次数':>8}{'覆盖率':>8}{'西幻覆盖':>9}"
          f"{'整体密度':>9}{'用过者中位':>11}")
    print('-' * 88)
    for r in rows[:args.top]:
        print(f"{r['word']:<8}{r['cat']:<6}{r['total']:>8}{r['coverage']*100:>7.0f}%"
              f"{r['genre_coverage']*100:>8.0f}%{r['kilo_overall']:>9.2f}"
              f"{r['kilo_med_used']:>11.2f}")

    ours = None
    if args.files:
        targets = []
        for p in args.files.split(';'):
            targets += sorted(glob.glob(p))
        if targets:
            text = ''.join(read_text(f) for f in targets)
            chars = norm_len(text) or 1
            cnt = count_words(text)
            ours = {'chars': chars, 'cnt': cnt,
                    'kilo': {w: 1000.0 * c / chars for w, c in cnt.items()}}
            hit = [(w, cnt[w], 1000.0 * cnt[w] / chars) for w in WORD_LIST if cnt[w]]
            print('\n' + '=' * 88)
            print(f'我们（{len(targets)} 章 / {chars} 字）命中情况')
            print('=' * 88)
            if hit:
                for w, c, k in sorted(hit, key=lambda x: -x[2]):
                    print(f'  {w:<8} {c:>4} 次  {k:>5.2f}/千字')
            else:
                print('  （候选词表内 0 命中）')
            top_real = [r['word'] for r in rows if r['coverage'] >= 0.30 and r['cat'] != '单字虚词']
            unused = [w for w in top_real if cnt[w] == 0]
            print(f"\n  真人覆盖率≥30% 的词共 {len(top_real)} 个，我们一个都没用的有 {len(unused)} 个：")
            print('  ' + '、'.join(unused))

    if args.json:
        out = {
            'corpus': args.corpus, 'n_books': len(per_book),
            'total_chars': total_chars, 'sample_chars': SAMPLE_CHARS,
            'genre_focus': args.genre, 'words': rows,
            'ours': ({'chars': ours['chars'],
                      'kilo': {w: round(ours['kilo'][w], 4) for w in WORD_LIST if ours['kilo'][w]},
                      'cnt': {w: ours['cnt'][w] for w in WORD_LIST if ours['cnt'][w]}}
                     if ours else None),
        }
        os.makedirs(os.path.dirname(args.json) or '.', exist_ok=True)
        io.open(args.json, 'w', encoding='utf-8').write(
            json.dumps(out, ensure_ascii=False, indent=1))
        print(f'\n→ {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
