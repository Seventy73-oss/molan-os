# -*- coding: utf-8 -*-
"""导出第4章纯文本 + 标点分布基线统计

作者指出第4章：零问号/零叹号/零省略号/零顿号/零分号，9 个疑问句全用句号收尾。
本脚本做两件事：
  ① 导出纯文本 txt（供朱雀送检）
  ② 量化：我们 vs 真人西幻档的标点密度基线（每千字），确认"标点被压平"到什么程度
"""
import glob
import io
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

CH = '15_新书_骨语者/chapters/第04章_第一笔账.md'
OUT_DIR = '15_新书_骨语者/07_审查版'
os.makedirs(OUT_DIR, exist_ok=True)

# ── ① 导出纯文本 ─────────────────────────────────────────────────────
raw = io.open(CH, encoding='utf-8').read()
body = re.sub(r'^\s*第[零一二三四五六七八九十百千0-9]+章[^\n]*\n+', '', raw)
out_txt = os.path.join(OUT_DIR, '第04章_第一笔账_纯文本.txt')
io.open(out_txt, 'w', encoding='utf-8', newline='\r\n').write(body.strip() + '\n')
chars = len(re.sub(r'\s', '', body))
print('已导出 %s（%d 非空白字符）' % (out_txt, chars))

# 四章合稿也导一份（方便整本送检）
all_files = sorted(glob.glob('15_新书_骨语者/chapters/*.md'))
parts = []
for f in all_files:
    t = io.open(f, encoding='utf-8').read()
    parts.append(t.strip())
all_txt = os.path.join(OUT_DIR, '全本_第01-04章_纯文本.txt')
io.open(all_txt, 'w', encoding='utf-8', newline='\r\n').write('\n\n'.join(parts) + '\n')
print('已导出 %s（%d 非空白字符）' % (all_txt, len(re.sub(r'\s', '', '\n\n'.join(parts)))))

# ── ② 标点统计 ───────────────────────────────────────────────────────
PUNCT = {
    '句号。': '。', '逗号，': '，', '问号？': '？', '叹号！': '！',
    '省略号……': '……', '顿号、': '、', '分号；': '；', '冒号：': '：',
    '破折号——': '——', '引号“”': '“',
}


def counts(text):
    n = len(re.sub(r'\s', '', text)) or 1
    d = {}
    for lab, ch in PUNCT.items():
        c = text.count(ch)
        if lab == '省略号……':
            c = len(re.findall(r'……', text))
        d[lab] = 1000.0 * c / n
    return d, n


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, max(0, int(round((len(v) - 1) * p))))]


# 我们的 4 章
ours = []
for f in all_files:
    t = io.open(f, encoding='utf-8').read()
    t = re.sub(r'^\s*第[零一二三四五六七八九十百千0-9]+章[^\n]*\n+', '', t)
    d, n = counts(t)
    ours.append((os.path.basename(f), d, n))

# 真人西幻档
genres = {}
for e in __import__('json').load(io.open('08_统计基线/题材标签_133本.json', encoding='utf-8')):
    genres[e['book']] = e.get('genre', '')
xh = [b for b, g in genres.items() if g == '西幻/异世界']
corpus = []
for b in xh:
    p = os.path.join('04_语料/真人语料_网文133本', b)
    if not os.path.exists(p):
        continue
    try:
        t = io.open(p, encoding='utf-8').read()
    except Exception:
        t = io.open(p, encoding='gb18030', errors='replace').read()
    d, n = counts(t[:200000])
    corpus.append(d)

print('\n=== 标点密度（每千字）==')
print('%-12s %s' % ('指标', ' '.join('%9s' % lab for lab in PUNCT)))
print('-' * 96)
print('%-12s' % '真人西幻档', end='')
for lab in PUNCT:
    v = [c[lab] for c in corpus]
    print(' %9s' % ('%.1f' % pct(v, .5)), end='')
print('   ← med')
print('%-12s' % '(p25~p75)', end='')
for lab in PUNCT:
    v = [c[lab] for c in corpus]
    print(' %9s' % ('%.1f~%.1f' % (pct(v, .25), pct(v, .75))), end='')
print()
for name, d, n in ours:
    print('%-12s' % name[:11], end='')
    for lab in PUNCT:
        print(' %9s' % ('%.2f' % d[lab]), end='')
    print('   (%d 字)' % n)

# 疑问句收尾统计（第4章）
t4 = io.open(CH, encoding='utf-8').read()
sents = [s for s in re.split(r'(?<=[。！？…”」])', t4) if s.strip()]
q_words = re.compile(r'(吗|呢|为什么|谁|什么|怎么|哪|几|多少|是不是|要不要|能不能|有没有|难道)')
q_like = [s for s in sents if q_words.search(s)]
q_dot = [s for s in q_like if s.rstrip().endswith('。')]
q_mark = [s for s in q_like if s.rstrip().endswith('？')]
print('\n=== 第4章疑问句收尾 ===')
print('  疑似疑问句 %d 个；其中以句号收尾 %d 个，以问号收尾 %d 个' % (len(q_like), len(q_dot), len(q_mark)))
for s in q_dot[:12]:
    print('    · ' + s.strip()[:34])
