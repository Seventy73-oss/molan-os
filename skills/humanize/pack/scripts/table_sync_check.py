# -*- coding: utf-8 -*-
"""table_sync_check.py — 门13 设定表同步核对（规则书 V0.36）

## 规则（作者裁定）

> "我让你建立的 12 个 excel 表格不是放在那看的，要同步更新的哇！这个要写入规则。"

**每写完/改完一章，必须同步回填设定表；表与正文不同步即打回。表是事实基底，不是存档。**
门13 保证"表是新的"，门12 保证"表和正文对得上"——**门13 不过，门12 的结论无意义。**

## 判据

【打回】每章必须在下列表里有行（按章号匹配）：
  · 章节细纲表（章号 / 崩口位 / 蓄势位 / 章尾模式 非空）
  · 节奏查询表（章号 / 节奏档位 / 章尾模式 非空）
  · 事件时间表（章号 / 绝对时间 / 事件名 非空）

【报警】允许缺行、但必须"近期更新过"（滞后 ≤ 2 章）：
  · 人物已知信息表、伏笔钩子台账、道具表

用法：
  python table_sync_check.py --chapters "chapters" --tables "设定表_书名.xlsx"
"""
import argparse
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from _tables import chap_num, col, find_tables, load_tables, rows_of  # noqa: E402

REQUIRED = [
    ('章节细纲表', ['章名', '情绪崩口位', '蓄势位', '章尾模式']),
    ('节奏查询表', ['节奏档位', '章尾模式']),
    ('事件时间表', ['绝对时间', '事件']),
]
SOFT = ['人物已知信息表', '伏笔钩子台账', '道具表']
LAG_MAX = 2


def chapter_no(fname):
    m = re.search(r'第\s*([0-9一二三四五六七八九十百零两]+)\s*章', fname)
    if not m:
        return None
    s = m.group(1)
    if s.isdigit():
        return int(s)
    CN = {'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6,
          '七': 7, '八': 8, '九': 9, '十': 10, '零': 0}
    if s in CN:
        return CN[s]
    if '十' in s:
        a, b = s.split('十', 1)
        return CN.get(a, 1 if a == '' else 0) * 10 + (CN.get(b, 0) if b else 0)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True)
    ap.add_argument('--tables', default=None)
    ap.add_argument('--lag-max', type=int, default=LAG_MAX, dest='lag_max')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.chapters, '*.md')))
    if not files:
        print('no chapters', file=sys.stderr)
        return 1
    chs = []
    for f in files:
        n = chapter_no(os.path.basename(f))
        if n:
            chs.append((n, os.path.basename(f)))
    if not chs:
        print('无法从文件名解析章号', file=sys.stderr)
        return 1
    chs.sort()

    tp = args.tables
    if not tp:
        cands = find_tables(args.chapters)
        tp = cands[0] if cands else None
    print('=' * 72)
    print(f'门13 设定表同步核对 | {len(chs)} 章 | 设定表：{tp or "未找到"}')
    print('=' * 72)
    if not tp or not os.path.exists(tp):
        print('\n== 打回 ==')
        print('  [C0 缺数据件] 未找到设定表工作簿。')
        print('\n门13 打回。')
        return 2

    tabs = load_tables(tp)
    bad, warn = [], []

    # 每张必需表里出现过的章号
    have = {}
    for sheet, cols in REQUIRED:
        rows = rows_of(tabs, sheet)
        if not rows:
            bad.append((sheet, '整张表为空'))
            continue
        nums = set()
        for r in rows:
            nums |= set(chap_num(col(r, '章号')))
        have[sheet] = nums
        for n, fn in chs:
            if n not in nums:
                bad.append((sheet, f'缺第{n}章的行（正文有 {fn}）'))
                continue
            r0 = [r for r in rows if n in chap_num(col(r, '章号'))][0]
            miss = [c for c in cols if not col(r0, c)]
            if miss:
                bad.append((sheet, f'第{n}章缺列：{"、".join(miss)}'))

    # 软表：滞后检查
    for sheet in SOFT:
        rows = rows_of(tabs, sheet)
        if not rows:
            warn.append((sheet, '整张表为空'))
            continue
        nums = set()
        for r in rows:
            nums |= set(chap_num(col(r, '章号')) or chap_num(col(r, '埋设章'))
                        or chap_num(col(r, '获知章号')))
        if not nums:
            warn.append((sheet, '无法解析章号列'))
            continue
        lag = max(n for n, _ in chs) - max(nums)
        if lag > args.lag_max:
            warn.append((sheet, f'最新章号 {max(nums)}，正文已到第{max(n for n, _ in chs)}章，'
                                f'滞后 {lag} 章 > {args.lag_max}'))

    print('\n[打回项]')
    if bad:
        for s, why in bad:
            print(f'  · {s}: {why}')
    else:
        print('  无')
    print('\n[报警项]')
    if warn:
        for s, why in warn:
            print(f'  · {s}: {why}')
    else:
        print('  无')

    if bad:
        print('\n门13 打回：设定表与正文不同步。先补表，再跑门12。')
        return 2
    print('\n门13 通过：必需表已覆盖全部已写章节。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
