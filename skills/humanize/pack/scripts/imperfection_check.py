# -*- coding: utf-8 -*-
"""imperfection_check.py — 门17 受控瑕疵核对（N13，规则书 V0.37，**只报警不打回**）

## 作者裁定（2026-09-09）

> "每章 1~2 处受控瑕疵（**不含半角标点**），标点符号的错误留着没必要。"

因此本门**不再把标点杂讯算作瑕疵**——标点必须干净（那是门6 的地盘：直引号=0、无半角标点）。
受控瑕疵只指：**形近错字 / 量词误用 / 口语粘连**这三类（脚本无法自动检出，靠登记核对）。

## 判据（全部只报警）

  · 某章登记项 **< 1** → 报警"本章缺受控瑕疵"
  · 某章登记项 **> 2** → 报警"超过每章 1~2 处上限"
  · 登记项在正文中**找不到** → 报警"被整合/恶人编辑洗掉了"
  · 登记项**落在人名/数字上** → 报警"违反禁落位置"

## V0.40.8 门精简（作者 2026-09-10 批准）

登记清单**为空**（`受控瑕疵清单.json` items=[]，说明本书未启用受控瑕疵）时，
不再逐章输出"登记 0 条 < 每章 1~2 处"报警（历史报告每章必报的恒定噪音）——
存在性提醒移交写章侧（瑕疵应在写作/整合阶段注入并登记，不是跑门时登记）。
清单**非空**时的核对行为不变（<1/>2/被洗掉/禁落位置仍报警）。

## 与门6 的关系（冲突已消解）

门6 管标点卫生；门17 管"错字类瑕疵有没有按登记注入"。
**标点必须干净，瑕疵只落在错字/量词/粘连——两者不再打架。**

用法：
  python imperfection_check.py --chapters "chapters" [--waiver 受控瑕疵清单.json]
                               [--tables 设定表.xlsx]   # 取人名做"禁落位置"核对
"""
import argparse
import glob
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def load_waiver(path):
    if not path or not os.path.exists(path):
        return []
    if path.lower().endswith('.json'):
        return [it for it in json.load(io.open(path, encoding='utf-8-sig')).get('items', [])
                if it.get('text')]
    out = []
    for ln in io.open(path, encoding='utf-8-sig'):
        ln = ln.strip()
        if ln and not ln.startswith('#'):
            parts = [p.strip() for p in ln.split('|')]
            out.append({'chapter': parts[0] if len(parts) > 1 else None, 'text': parts[-1]})
    return out


def names_from_tables(path):
    if not path or not os.path.exists(path):
        return []
    try:
        from _tables import col, load_tables, rows_of
        tabs = load_tables(path)
        ns = []
        for sheet in ('主角设定表', '配角设定表'):
            for r in rows_of(tabs, sheet):
                n = col(r, '姓名')
                if n:
                    ns.append(n)
                    ns += [a.strip() for a in re.split(r'[；;、/|]', col(r, '别名', '别名/外号'))
                           if a.strip()]
        return ns
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True)
    ap.add_argument('--waiver', default=None)
    ap.add_argument('--tables', default=None)
    ap.add_argument('--min-per-chapter', type=int, default=1, dest='min_ch')
    ap.add_argument('--max-per-chapter', type=int, default=2, dest='max_ch')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.chapters, '*.md')))
    if not files:
        print('no chapters', file=sys.stderr)
        return 1
    waiver = load_waiver(args.waiver)
    names = names_from_tables(args.tables)

    print('=' * 72)
    print('门17 受控瑕疵核对（只报警不打回）')
    print('  规则：每章 1~2 处，**不含半角标点**；标点必须干净（门6 管）')
    print(f'  登记清单：{len(waiver)} 条' + (f'｜人名（禁落位置）：{len(names)} 个' if names else ''))
    print('=' * 72)

    # V0.40.8 门精简（作者 2026-09-10 批准）：登记清单为空（items=[]）＝本书未启用
    # 受控瑕疵 → 不再逐章输出"登记 0 条 < 每章 1~2 处"报警（恒定噪音，无人执行）；
    # 存在性提醒移交写章侧。清单非空时下方核对行为不变。
    if not waiver:
        print('\n[说明] 受控瑕疵登记清单为空（本书未启用受控瑕疵）——'
              '"登记 0 条 < 每章 1~2 处"的提醒已移交写章侧（V0.40.8 门精简）；本门跳过核对。')
        print('\n门17 完成（只报警，不影响 exit code）。')
        return 0

    warn = []
    for fp in files:
        name = os.path.basename(fp)
        t = io.open(fp, encoding='utf-8').read()
        mine = [it for it in waiver
                if not it.get('chapter') or it['chapter'] in name]
        print(f'\n{name}：登记 {len(mine)} 条')
        if len(mine) < args.min_ch:
            warn.append((name, f'登记 {len(mine)} 条 < 每章 {args.min_ch}~{args.max_ch} 处'
                               f'（过度洁净是指纹）'))
        if len(mine) > args.max_ch:
            warn.append((name, f'登记 {len(mine)} 条 > 每章上限 {args.max_ch}'))
        for it in mine:
            txt = it['text']
            if txt not in t:
                warn.append((name, f'登记项「{txt[:18]}」在正文中找不到（被洗掉？）'))
                continue
            for n in names:
                if n and n in txt:
                    warn.append((name, f'登记项「{txt[:18]}」落在人名「{n}」上（禁落位置）'))
            if re.search(r'\d', txt):
                warn.append((name, f'登记项「{txt[:18]}」含数字（禁落位置）'))
            print(f'    · {it.get("type", "瑕疵")}：{txt[:24]}')

    print('\n[报警项]')
    for name, why in warn:
        print(f'  · {name}：{why}')
    if not warn:
        print('  无')
    print('\n门17 完成（只报警，不影响 exit code）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
