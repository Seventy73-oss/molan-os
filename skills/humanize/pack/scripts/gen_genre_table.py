# -*- coding: utf-8 -*-
"""gen_genre_table.py — 从题材基线 JSON 生成「分题材对照表」markdown（进规则书第十二节）

用法：
  python gen_genre_table.py --baseline ../08_统计基线/题材基线_98本.json [--out table.md]
"""
import argparse
import io
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

LABELS = [('smean', '均句长'), ('ssd', '句长sd'), ('pmean', '均段长'), ('psd', '段长sd'),
          ('dlg_pct', '对白段%'), ('env2_pct', '环境段%严格'), ('said_kilo', '说族/千字'),
          ('simile_kilo', '明喻/千字'), ('conn_kilo', '承接词/千字')]


def row(name, d):
    cells = [name, str(d.get('n', ''))]
    for k, _ in LABELS:
        v = d.get(k)
        cells.append(f'{v["min"]}~{v["max"]}' if v else '—')
    cells.append(str(d.get('noise_per1k', '—')))
    return '| ' + ' | '.join(cells) + ' |'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--baseline', required=True)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    d = json.load(io.open(args.baseline, encoding='utf-8'))
    lines = []
    lines.append('| 题材档 | n | ' + ' | '.join(l for _, l in LABELS) + ' | 杂讯/千字 |')
    lines.append('|---' * (len(LABELS) + 3) + '|')
    order = sorted(d.get('genres', {}).items(), key=lambda x: -x[1].get('n', 0))
    for g, gd in order:
        lines.append(row(g, gd))
    lines.append(row('**全库**', d['all']))
    txt = '\n'.join(lines)
    print(txt)
    if args.out:
        io.open(args.out, 'w', encoding='utf-8').write(txt + '\n')
        print(f'\n已写 {args.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
