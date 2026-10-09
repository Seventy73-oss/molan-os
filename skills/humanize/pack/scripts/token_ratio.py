# -*- coding: utf-8 -*-
"""十万字成本测算 · 第一步：中文字符 → token 比例实测

用本地 Qwen2.5 分词器（与 DeepSeek/GLM 同为 BPE 系，量级可比）实测：
  · 我们的正文（4 章）
  · 真人语料（随机抽 6 本 × 前 2 万字）
  · 规划表 / 设定表导出文本（结构化中文，token 效率更低）
统计口径：
  · 非空白字符数（含标点）
  · 纯汉字数
  · token 数
输出：字符/token、token/千字，供成本估算用。
"""
import glob
import io
import os
import random
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
from transformers import AutoTokenizer  # noqa: E402

MODEL = r'E:\agent文章内容\models\Qwen2.5-3B-Instruct'
tok = AutoTokenizer.from_pretrained(MODEL)

HAN = re.compile(r'[\u4e00-\u9fff]')


def stat(name, text):
    nows = re.sub(r'\s', '', text)
    han = len(HAN.findall(text))
    n_tok = len(tok.encode(text, add_special_tokens=False))
    if not n_tok:
        return None
    return {'name': name, 'chars': len(nows), 'han': han, 'tokens': n_tok,
            'chars_per_tok': len(nows) / n_tok, 'han_per_tok': han / n_tok,
            'tok_per_kchar': 1000.0 * n_tok / max(len(nows), 1)}


rows = []
for f in sorted(glob.glob('15_新书_骨语者/chapters/*.md')):
    rows.append(stat(os.path.basename(f), io.open(f, encoding='utf-8').read()))

books = sorted(glob.glob('04_语料/真人语料_网文133本/*.txt'))
random.Random(20260910).shuffle(books)
for b in books[:6]:
    try:
        t = io.open(b, encoding='utf-8').read()
    except Exception:
        t = io.open(b, encoding='gb18030', errors='replace').read()
    rows.append(stat('语料·' + os.path.basename(b)[:16], t[20000:40000]))

for f in ['15_新书_骨语者/02_规划表_第04章.md', '15_新书_骨语者/12_风格锚点卡.md',
          '15_新书_骨语者/00_设定与卷纲.md']:
    if os.path.exists(f):
        rows.append(stat('结构件·' + os.path.basename(f), io.open(f, encoding='utf-8').read()))

print('%-34s %8s %8s %8s %9s %10s' % ('样本', '非空字符', '汉字', 'token', '字符/token', 'token/千字'))
print('-' * 86)
for r in rows:
    print('%-34s %8d %8d %8d %9.2f %10.1f' % (
        r['name'][:34], r['chars'], r['han'], r['tokens'], r['chars_per_tok'], r['tok_per_kchar']))

def avg(key, subset=None):
    v = [r[key] for r in (subset or rows)]
    return sum(v) / len(v)

ours = [r for r in rows if r['name'].startswith('第')]
corp = [r for r in rows if r['name'].startswith('语料')]
struct = [r for r in rows if r['name'].startswith('结构件')]
print('\n== 汇总 ==')
for tag, sub in [('我们正文 4 章', ours), ('真人语料 6 样本', corp), ('结构化文档', struct), ('全部', rows)]:
    if sub:
        print('%-16s 字符/token %.3f  token/千字符 %.1f  汉字/token %.3f' % (
            tag, avg('chars_per_tok', sub), avg('tok_per_kchar', sub), avg('han_per_tok', sub)))
