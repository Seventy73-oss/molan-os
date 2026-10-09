# -*- coding: utf-8 -*-
"""merge_batch.py — 把清洗后的新批次合并进主语料库（去重 + 重命名 + 统计）

用法：
  python merge_batch.py --src _clean_new2 --dst 真人语料_网文98本 [--dry-run]
"""
import argparse
import io
import os
import re
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from corpus_tool import fname_key, norm_key, read_text, stats  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--dst', required=True)
    ap.add_argument('--dry-run', action='store_true', dest='dry')
    args = ap.parse_args()

    existing = {}
    for n in os.listdir(args.dst):
        if n.endswith('.txt'):
            existing[fname_key(os.path.join(args.dst, n))] = n
    print(f'主库现有 {len(existing)} 本')

    added, dup, skipped = [], [], []
    for n in sorted(os.listdir(args.src)):
        if not n.endswith('.txt'):
            continue
        src = os.path.join(args.src, n)
        base = os.path.splitext(n)[0]
        base = re.sub(r'^\d+_', '', base)
        base = re.sub(r'_前\d+章$', '', base)
        key = norm_key(base)
        if key in existing:
            dup.append((n, existing[key]))
            continue
        t = read_text(src)
        s = stats(t)
        if s['chars'] < 50000:
            skipped.append((n, s['chars']))
            continue
        dst = os.path.join(args.dst, base + '.txt')
        if not args.dry:
            shutil.copyfile(src, dst)
        existing[key] = base + '.txt'
        added.append((base + '.txt', s['chars']))

    print(f'\n新增 {len(added)} 本：')
    for n, c in added:
        print(f'  + {n}  {c} 字')
    print(f'\n重复跳过 {len(dup)} 本：')
    for a, b in dup:
        print(f'  = {a}  ←→  {b}')
    if skipped:
        print(f'\n过短跳过 {len(skipped)} 本：')
        for n, c in skipped:
            print(f'  - {n}  {c} 字')
    print(f'\n合并后主库：{len(existing)} 本')


if __name__ == '__main__':
    main()

