# -*- coding: utf-8 -*-
"""把《设定表》xlsx 的「章节细纲表」导出成 tail_check.py 能直接读的 beat 文件。
用法：
  python 13_设定表/export_beats.py 13_设定表/设定表_示例_我的魔力要分期.xlsx
  python 03_评分与校准/tail_check.py --files "12_实测/chapters/*.md" --beats 13_设定表/设定表_示例_我的魔力要分期_beats.md
"""
import argparse
import os
import sys

import openpyxl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--sheet', default='章节细纲表')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    if not os.path.exists(args.xlsx):
        print('文件不存在：', args.xlsx, file=sys.stderr)
        sys.exit(1)
    wb = openpyxl.load_workbook(args.xlsx, data_only=True)
    if args.sheet not in wb.sheetnames:
        print('缺少工作表：', args.sheet, file=sys.stderr)
        sys.exit(1)
    ws = wb[args.sheet]

    heads = {ws.cell(row=3, column=c).value: c for c in range(1, ws.max_column + 1)
             if ws.cell(row=3, column=c).value}

    def col(prefix):
        for h, c in heads.items():
            if h.startswith(prefix):
                return c
        return None

    c_no, c_name = col('章号'), col('章名')
    fields = [('失控事件', col('失控事件')), ('实际代价', col('实际代价')),
              ('未解决尾巴', col('未解决尾巴')), ('失败章', col('失败章')),
              ('情绪崩口位', col('情绪崩口位')), ('蓄势位', col('蓄势位'))]
    if not c_no:
        print('找不到「章号」列', file=sys.stderr)
        sys.exit(1)

    out, n = [], 0
    for r in range(4, ws.max_row + 1):
        no = ws.cell(row=r, column=c_no).value
        if no in (None, ''):
            continue
        n += 1
        name = ws.cell(row=r, column=c_name).value or '' if c_name else ''
        out.append(f"### 第{no}章 {name}".rstrip())
        for label, ci in fields:
            v = ws.cell(row=r, column=ci).value if ci else None
            if v not in (None, ''):
                out.append(f"- {label}：{v}")
        out.append('')

    dst = args.out or os.path.splitext(args.xlsx)[0] + '_beats.md'
    open(dst, 'w', encoding='utf-8').write('\n'.join(out))
    print(f"已导出 {dst}（章节数 {n}）")


if __name__ == '__main__':
    main()
