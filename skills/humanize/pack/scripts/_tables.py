# -*- coding: utf-8 -*-
"""_tables.py — 设定表读取器（门12 / 门7E 共用的数据件入口）

项目约定：设定表工作簿的表头在第 3 行（第 1 行是标题），数据从第 4 行起。

用法：
    from _tables import load_tables, rows_of, chapters_of
    tabs = load_tables('设定表_骨语者.xlsx')
    for r in rows_of(tabs, '道具表'):
        print(r['道具名'], r['章号'])

设计说明：机器门要核对的「事实」不写在脚本里，只写在表里——
作者改表，门就跟着改；脚本不含任何本书专有名词。
"""
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HEADER_ROW = 3
CN = {'一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6,
      '七': 7, '八': 8, '九': 9, '十': 10}


def cn2int(s):
    s = str(s).strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if s in CN:
        return CN[s]
    if s.startswith('十'):
        return 10 + CN.get(s[1:], 0)
    if '十' in s:
        a, b = s.split('十', 1)
        return CN.get(a, 0) * 10 + (CN.get(b, 0) if b else 0)
    return None


def chap_num(value):
    """从「第2章」「2」「第1章/第3章」里取章号列表（取不到返回空列表）。"""
    out = []
    for m in re.finditer(r'第([一二三四五六七八九十百两\d]{1,4})章', str(value)):
        n = cn2int(m.group(1))
        if n:
            out.append(n)
    if not out:
        n = cn2int(value)
        if n:
            out.append(n)
    return out


def day_num(value):
    """从「第3天」「3」里取"第几天"（取不到返回空列表）。"""
    out = []
    for m in re.finditer(r'第?([一二三四五六七八九十百两\d]{1,4})天', str(value)):
        n = cn2int(m.group(1))
        if n:
            out.append(n)
    if not out:
        n = cn2int(value)
        if n:
            out.append(n)
    return out


def load_tables(path):
    """读工作簿 → {表名: [ {列名: 值} ... ]}，空行跳过。"""
    from openpyxl import load_workbook
    if not path or not os.path.exists(path):
        raise FileNotFoundError('找不到设定表：%s' % path)
    wb = load_workbook(path, data_only=True)
    tabs = {}
    for name in wb.sheetnames:
        ws = wb[name]
        headers = []
        for c in range(1, ws.max_column + 1):
            v = ws.cell(row=HEADER_ROW, column=c).value
            headers.append(str(v).strip() if v is not None else '')
        rows = []
        for r in range(HEADER_ROW + 1, ws.max_row + 1):
            vals = [ws.cell(row=r, column=c).value for c in range(1, ws.max_column + 1)]
            if all(v is None or str(v).strip() == '' for v in vals):
                continue
            d = {}
            for h, v in zip(headers, vals):
                if h:
                    d[h] = ('' if v is None else str(v).strip())
            rows.append(d)
        tabs[name] = rows
    return tabs


def rows_of(tabs, sheet):
    return tabs.get(sheet, [])


def col(row, *names):
    """按列名前缀取列值（容忍表头里带括号的说明，如「状态（在场/离场…）」）。"""
    for n in names:
        if n in row:
            return row[n]
    for k, v in row.items():
        for n in names:
            if k.startswith(n):
                return v
    return ''


def find_tables(start_dir):
    """在章节目录及其上级目录里找唯一的 设定表_*.xlsx。"""
    cands = []
    for root in (start_dir, os.path.dirname(os.path.abspath(start_dir)),
                 os.path.dirname(os.path.dirname(os.path.abspath(start_dir)))):
        if not root or not os.path.isdir(root):
            continue
        for f in sorted(os.listdir(root)):
            if f.startswith('设定表') and f.endswith('.xlsx') and not f.startswith('~$'):
                cands.append(os.path.join(root, f))
    return cands
