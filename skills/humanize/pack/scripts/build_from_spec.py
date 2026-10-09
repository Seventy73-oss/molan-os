# -*- coding: utf-8 -*-
"""
build_from_spec.py — 通用设定表生成器（读 JSON 规格 → 写 xlsx）

用法：
  python 13_设定表/build_from_spec.py <spec.json> <out.xlsx>

spec.json 结构：
{
 "book": "书名",
 "sheets": [
   {"name": "主题定位表", "title": "主题定位表", "header_row": 3,
    "headers": ["项目","内容","填写要求"], "widths": [26,62,40],
    "rows": [[...],[...]], "freeze": "A4", "fill": "FFF2CC",
    "dropdowns": [{"range":"G4:G300","items":["是","否"]}],
    "stats": {"col":11,"rows":[["统计项","结果 / 判据"],["总章数","=COUNT($A$4:$A$300)"]]}}
 ]
}
说明：单元格文本请避免 ASCII 双引号（用「」），JSON 里才不用转义。
"""
import argparse
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

HEAD_FILL = PatternFill('solid', fgColor='2F5597')
HEAD_FONT = Font(bold=True, color='FFFFFF', size=11)
TITLE_FONT = Font(bold=True, size=14, color='2F5597')
STAT_FILL = PatternFill('solid', fgColor='E2EFDA')
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical='top')
CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)


def build(spec, out):
    wb = Workbook()
    wb.remove(wb.active)
    for sh in spec['sheets']:
        ws = wb.create_sheet(sh['name'])
        if sh.get('title'):
            ws['A1'] = sh['title']
            ws['A1'].font = TITLE_FONT
        hr = sh.get('header_row', 3)
        headers = sh['headers']
        for i, h in enumerate(headers, 1):
            c = ws.cell(row=hr, column=i, value=h)
            c.fill, c.font, c.alignment, c.border = HEAD_FILL, HEAD_FONT, CENTER, BORDER
        ws.row_dimensions[hr].height = 34
        for i, w in enumerate(sh.get('widths', []), 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        fill = PatternFill('solid', fgColor=sh['fill']) if sh.get('fill') else None
        for r, row in enumerate(sh.get('rows', []), hr + 1):
            for i, v in enumerate(row, 1):
                c = ws.cell(row=r, column=i, value=v)
                c.alignment, c.border = WRAP, BORDER
                if fill:
                    c.fill = fill
        for d in sh.get('dropdowns', []):
            dv = DataValidation(type='list', formula1='"%s"' % ','.join(d['items']),
                                allow_blank=True)
            ws.add_data_validation(dv)
            dv.add(d['range'])
        st = sh.get('stats')
        if st:
            col = st['col']
            for i, (k, v) in enumerate(st['rows']):
                r = hr + i
                a = ws.cell(row=r, column=col, value=k)
                b = ws.cell(row=r, column=col + 1, value=v)
                if i == 0:
                    a.fill = b.fill = HEAD_FILL
                    a.font = b.font = HEAD_FONT
                else:
                    a.fill = b.fill = STAT_FILL
                a.alignment = b.alignment = WRAP
                a.border = b.border = BORDER
            ws.column_dimensions[get_column_letter(col)].width = 26
            ws.column_dimensions[get_column_letter(col + 1)].width = 44
        if sh.get('freeze'):
            ws.freeze_panes = sh['freeze']
    wb.save(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('spec')
    ap.add_argument('out')
    args = ap.parse_args()
    spec = json.load(open(args.spec, encoding='utf-8-sig'))
    build(spec, args.out)
    print('已生成', args.out, '| 工作表', len(spec['sheets']), '张')


if __name__ == '__main__':
    main()
