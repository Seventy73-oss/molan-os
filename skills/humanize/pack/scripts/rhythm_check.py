# -*- coding: utf-8 -*-
"""rhythm_check.py — 门16 节奏与身体性核对（N10/N14，规则书 V0.36）

## 对应规则

  · N10 章尾模式：爽点优先；**连续 2 章爽点后，下一章强制降级静默章尾**；
    章节标题风格随章尾模式分布（静默配非事件式；不许全部事件式）。
  · N14 身体性场景配额：非静态题材每 5 章 ≥1 场动作/身体在场戏。
  · 门8 结构级：失败章间隔 3~20 且不固定；谈判闭环 ≤2/3。

## 判据

【打回】连续 3 章及以上都是"爽点"章尾（违反"2 章后强制静默"）
【报警】全部章节标题风格都是"事件式"
【报警】任意连续 5 章窗口内没有身体性场景
【报警】失败章间隔固定（相邻间隔完全相同 → 机器指纹）
【报警】谈判闭环占比 > 2/3

数据源：设定表「节奏查询表」＋「章节细纲表」。
用法：
  python rhythm_check.py --tables "设定表_书名.xlsx"
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from _tables import chap_num, col, find_tables, load_tables, rows_of  # noqa: E402

BODY_WORDS = ('打', '斗', '跑', '追', '扛', '搬', '挖', '爬', '跳', '摔', '拳',
              '刀', '剑', '砍', '烧', '煮', '吃', '骑', '游', '逃', '抓', '拽',
              '推', '拉', '背', '抬', '跪', '滚', '撕', '掐', '绑', '拴')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tables', default=None)
    ap.add_argument('--chapters-dir', default=None, help='用章节目录定位设定表')
    ap.add_argument('--window', type=int, default=5, help='身体性场景窗口（默认5章）')
    args = ap.parse_args()

    tp = args.tables
    if not tp and args.chapters_dir:
        c = find_tables(args.chapters_dir)
        tp = c[0] if c else None
    print('=' * 72)
    print(f'门16 节奏与身体性核对 | 设定表：{tp or "未找到"}')
    print('=' * 72)
    if not tp or not os.path.exists(tp):
        print('\n== 打回 ==\n  [C0 缺数据件] 未找到设定表。\n\n门16 打回。')
        return 2
    tabs = load_tables(tp)

    rhythm = []
    for r in rows_of(tabs, '节奏查询表'):
        n = (chap_num(col(r, '章号')) or [None])[0]
        if n:
            rhythm.append({'n': n, '档位': col(r, '节奏档位'),
                           '章尾': col(r, '章尾模式'), '失败章': col(r, '失败章'),
                           '疲惫段': col(r, '疲惫段'), '冲突': col(r, '冲突解决方式'),
                           '钩子': col(r, '钩子')})
    rhythm.sort(key=lambda x: x['n'])
    if not rhythm:
        print('\n== 打回 ==\n  [C0 缺表] 节奏查询表为空。\n\n门16 打回。')
        return 2

    detail = {}
    for r in rows_of(tabs, '章节细纲表'):
        n = (chap_num(col(r, '章号')) or [None])[0]
        if n:
            detail[n] = {'标题风格': col(r, '章节标题风格'),
                         '章尾': col(r, '章尾模式'),
                         '失控': col(r, '失控事件')}

    bad, warn = [], []

    # N10a 连续爽点
    run, run_start = 0, None
    for r in rhythm:
        if '爽点' in r['章尾']:
            if run == 0:
                run_start = r['n']
            run += 1
            if run >= 3:
                bad.append(f'第{run_start}~{r["n"]}章连续 {run} 章"爽点"章尾'
                           f'（规则：连续 2 章后必须强制静默）')
                run = 0
        else:
            run = 0

    # N10b 标题风格
    styles = [v['标题风格'] for v in detail.values() if v['标题风格']]
    if styles and all('事件' in s for s in styles):
        warn.append('全部章节标题都是"事件式"（规则：静默章尾应配非事件式标题）')

    # N14 身体性场景
    nums = sorted(detail)
    for i in range(len(nums)):
        win = nums[i:i + args.window]
        if len(win) < args.window:
            break
        hit = [n for n in win
               if any(w in (detail[n]['失控'] or '') for w in BODY_WORDS)]
        if not hit:
            warn.append(f'第{win[0]}~{win[-1]}章连续 {args.window} 章无身体性场景'
                        f'（规则：非静态题材每 5 章 ≥1 场）')

    # 失败章间隔
    fails = [r['n'] for r in rhythm if '是' in r['失败章']]
    if len(fails) >= 3:
        gaps = [b - a for a, b in zip(fails, fails[1:])]
        if len(set(gaps)) == 1:
            warn.append(f'失败章间隔固定为 {gaps[0]} 章（机器指纹；规则要求 3~20 且不固定）')
        elif any(g < 3 or g > 20 for g in gaps):
            warn.append(f'失败章间隔 {gaps} 越出 3~20')

    # 谈判闭环占比
    tally = [r['冲突'] for r in rhythm if r['冲突']]
    if tally:
        talk = sum(1 for t in tally if '谈判' in t)
        if talk / len(tally) > 2 / 3:
            warn.append(f'谈判闭环占比 {talk}/{len(tally)} > 2/3')

    print(f'\n节奏查询表 {len(rhythm)} 章｜章节细纲表 {len(detail)} 章')
    print('章尾序列：' + ' '.join(f'{r["n"]}:{r["章尾"] or "—"}' for r in rhythm[:20]))
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
        print('\n门16 打回。')
        return 2
    print('\n门16 通过（报警项由作者决定）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
