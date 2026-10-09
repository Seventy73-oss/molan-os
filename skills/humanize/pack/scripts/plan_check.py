# -*- coding: utf-8 -*-
"""plan_check.py — 门15 规划表完整性 + 打字机模式核对（N4/N5，规则书 V0.36）

## 对应规则

  · N4 规划表（流水线阶段1.5）：60~90 段，每段含 功能/字数预算/状态变更；
    字数预算合计先按 2500~4500 分配再拆段。
  · N5 打字机模式（阶段2）：按表逐段写足，不总结/不收尾/不解释。

## 判据

【打回】规划表缺必填列（功能/字数预算/状态变更任一为空）
【打回】规划表字数预算合计越出 2500~4500
【打回】正文已存在且**正文段数 < 规划表段数 × 0.8**（打字机模式没执行）
【报警】规划表段数越出 60~90
【报警】崩口位行数越出 1~3；蓄势位（≥120字行）< 1

用法：
  python plan_check.py --plan "02_规划表_第01章.md" [--chapters-dir "chapters"]
"""
import argparse
import glob
import io
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROW = re.compile(r'^\s*\|')


def parse_plan(path):
    """解析 markdown 规划表 → [{'编号','功能','字数','内容'}]"""
    rows = []
    header = None
    for ln in io.open(path, encoding='utf-8'):
        if not ROW.match(ln):
            continue
        cells = [c.strip() for c in ln.strip().strip('|').split('|')]
        if header is None:
            header = cells
            continue
        if set(''.join(cells)) <= set('-: '):
            continue
        rows.append(cells)
    return header or [], rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--chapters-dir', default=None)
    ap.add_argument('--chapter', default=None, help='章号（如 第01章）；给了才能核对正文段数')
    ap.add_argument('--min-chars', type=int, default=2500, dest='min_chars')
    ap.add_argument('--max-chars', type=int, default=4500, dest='max_chars')
    ap.add_argument('--seg-min', type=int, default=60, dest='seg_min')
    ap.add_argument('--seg-max', type=int, default=90, dest='seg_max')
    args = ap.parse_args()

    if not os.path.exists(args.plan):
        print(f'找不到规划表：{args.plan}', file=sys.stderr)
        return 1
    header, rows = parse_plan(args.plan)
    print('=' * 72)
    print(f'门15 规划表完整性 + 打字机模式 | {os.path.basename(args.plan)}')
    print('=' * 72)
    print(f'表头：{" | ".join(header)}')
    print(f'数据行：{len(rows)}')

    bad, warn = [], []
    # 必填列
    def col_idx(*names):
        for i, h in enumerate(header):
            for n in names:
                if n in h:
                    return i
        return None

    i_func = col_idx('功能')
    i_num = col_idx('字数')
    i_state = col_idx('内容', '状态', '要点')

    total = 0
    empty_rows = []
    for k, cells in enumerate(rows, 1):
        def get(i):
            return cells[i].strip() if i is not None and i < len(cells) else ''
        f, num, st = get(i_func), get(i_num), get(i_state)
        if not f or not num or not st:
            empty_rows.append(k)
        m = re.search(r'\d+', num)
        if m:
            total += int(m.group(0))
    if empty_rows:
        bad.append(f'第 {empty_rows[:8]}{"…" if len(empty_rows) > 8 else ""} 行缺必填列'
                   f'（功能/字数预算/状态变更）')
    print(f'\n字数预算合计：{total}（要求 {args.min_chars}~{args.max_chars}）')
    if not (args.min_chars <= total <= args.max_chars):
        bad.append(f'字数预算合计 {total} 越出 {args.min_chars}~{args.max_chars}')
    if not (args.seg_min <= len(rows) <= args.seg_max):
        warn.append(f'段数 {len(rows)} 越出规则书建议的 {args.seg_min}~{args.seg_max}'
                    f'（此为建议值，报警不打断）')

    # 崩口位/蓄势位
    breaks = [c for c in rows if i_func is not None and i_func < len(c)
              and '崩口' in c[i_func]]
    longs = []
    for c in rows:
        if i_num < len(c):
            m = re.search(r'\d+', c[i_num])
            if m and int(m.group(0)) >= 120:
                longs.append(c)
    if not (1 <= len(breaks) <= 3):
        warn.append(f'崩口位 {len(breaks)} 行（规则要求 1~3）')
    if len(longs) < 1:
        warn.append('无蓄势位行（字数预算 ≥120 的行至少 1 个）')

    # 打字机模式：正文段数 vs 规划表段数
    if args.chapters_dir and args.chapter:
        from _tables import chap_num
        n = (chap_num(args.chapter) or [None])[0]
        files = [f for f in glob.glob(os.path.join(args.chapters_dir, '*.md'))
                 if n and (chap_num(os.path.basename(f)) or [0])[0] == n]
        if files:
            text = io.open(files[0], encoding='utf-8').read()
            paras = [p for p in text.split('\n') if p.strip()]
            paras = [p for p in paras if not p.strip().startswith('#')]
            print(f'正文段数：{len(paras)}（规划表 {len(rows)} 段）')
            if len(paras) < len(rows) * 0.8:
                bad.append(f'正文段数 {len(paras)} < 规划表段数 {len(rows)} × 0.8'
                           f' → 打字机模式未执行（可能是"写短再补"）')
        else:
            print(f'未找到第{n}章正文，跳过段数核对')

    print('\n[打回项]')
    for x in bad:
        print('  · ' + x)
    if not bad:
        print('  无')
    print('\n[报警项]')
    for x in warn:
        print('  · ' + x)
    if not warn:
        print('  无')
    if bad:
        print('\n门15 打回。')
        return 2
    print('\n门15 通过（报警项由作者决定）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
