# -*- coding: utf-8 -*-
"""make_review_pack.py — 生成审查版（纯文本合稿 + 逐章纯文本）

为什么需要：markdown 章节里的 `#`、`---`、加粗标记会污染真人审查与外部AI审查的输入；
审查版必须是**纯正文**，且章与章之间用固定分隔，方便对照定位。

用法：
  python make_review_pack.py --chapters ..\\15_新书_骨语者\\chapters --out ..\\15_新书_骨语者\\07_审查版
"""
import argparse
import glob
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 只清掉"排版标记"，不动正文任何一个字
STRIP = [
    (re.compile(r'^\s*#{1,6}\s*', re.M), ''),      # 标题井号
    (re.compile(r'^\s*[-*_]{3,}\s*$', re.M), ''),  # 分隔线
    (re.compile(r'\*\*(.+?)\*\*'), r'\1'),          # 加粗
    (re.compile(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)'), r'\1'),  # 斜体
    (re.compile(r'^\s*>\s?', re.M), ''),            # 引用
]


def clean(text):
    t = text
    for pat, rep in STRIP:
        t = pat.sub(rep, t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip() + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--title', default='骨语者')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.chapters, '*.md')))
    if not files:
        print('no chapters', file=sys.stderr)
        return 1
    os.makedirs(args.out, exist_ok=True)

    parts = []
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        body = clean(open(f, encoding='utf-8').read())
        open(os.path.join(args.out, name + '.txt'), 'w', encoding='utf-8').write(body)
        parts.append(f'【{name}】\n\n{body}')
        print(f'  {name}.txt  {len(re.sub(chr(92) + "s", "", body))} 字')

    full = f'《{args.title}》试读 · 前{len(files)}章 全本合稿（纯文本）\n' + '=' * 40 + '\n\n'
    full += ('\n' + '=' * 40 + '\n\n').join(parts)
    full += f'\n\n' + '=' * 40 + f'\n（合计 {len(re.sub(chr(92) + "s", "", full))} 字）\n'
    open(os.path.join(args.out, '全本合稿_纯文本.txt'), 'w', encoding='utf-8').write(full)
    print(f'\n合稿：{os.path.join(args.out, "全本合稿_纯文本.txt")}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
