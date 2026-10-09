# -*- coding: utf-8 -*-
"""困惑度诊断实验：token 级 NLL 分布对比（我们 vs 真人）

目的：困惑度只给一个均值，看不出"我们缺什么"。本脚本算 token 级 NLL 分布：
  · 分位数（p10/p25/p50/p75/p90）
  · 高 NLL token（意外之处）占比与内容
  · 低 NLL token（一眼可猜）占比
  · 与真人样本对比

口径：Qwen2.5-3B-Instruct，每段文本截前 4000 字符（与 ppl 基线一致）。
"""
import glob
import io
import os
import statistics as st
import sys

sys.stdout.reconfigure(encoding='utf-8')
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

MODEL = r'E:\agent文章内容\models\Qwen2.5-3B-Instruct'
MAX_CHARS = 4000
torch.manual_seed(0)

tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype='auto').to('cuda').eval()
print('模型已加载', flush=True)


def nll_list(text):
    ids = tok(text[:MAX_CHARS], return_tensors='pt').input_ids.to('cuda')
    with torch.no_grad():
        logits = model(ids).logits
    logits = logits[:, :-1, :]
    labels = ids[:, 1:]
    nll = torch.nn.functional.cross_entropy(
        logits.reshape(-1, logits.size(-1)), labels.reshape(-1), reduction='none').tolist()
    toks = [tok.decode([t]) for t in ids[0, 1:].tolist()]
    return nll, toks


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, max(0, int(round((len(v) - 1) * p))))]


def report(name, text):
    nll, toks = nll_list(text)
    m = st.mean(nll)
    sd = st.pstdev(nll)
    hi = pct(nll, .90)
    lo = pct(nll, .10)
    pairs = sorted(zip(nll, toks), reverse=True)
    high_share = 100.0 * sum(1 for x in nll if x > 3.0) / len(nll)
    low_share = 100.0 * sum(1 for x in nll if x < 0.5) / len(nll)
    print('\n=== %s ===' % name)
    print('  字符 %d / token %d' % (len(text[:MAX_CHARS]), len(nll)))
    print('  困惑度 %.2f   nll 均值 %.3f   nll sd %.3f' % (2.718281828 ** m, m, sd))
    print('  nll 分位: p10 %.2f  p25 %.2f  p50 %.2f  p75 %.2f  p90 %.2f  max %.2f'
          % (lo, pct(nll, .25), pct(nll, .5), pct(nll, .75), hi, max(nll)))
    print('  意外度 >3.0 的 token 占比 %.1f%%   <0.5 的占比 %.1f%%' % (high_share, low_share))
    print('  最意外的 15 个 token（去标点/空白）:')
    shown = 0
    for x, t in pairs:
        if not t.strip() or t in '，。！？、“”‘’：；—…「」（）':
            continue
        print('    %-6s nll=%.2f' % (t, x))
        shown += 1
        if shown >= 15:
            break
    return {'ppl': 2.718281828 ** m, 'sd': sd, 'p90': hi, 'p10': lo,
            'high': high_share, 'low': low_share}


# 我们：第 4 章（新流程）
ours = io.open('15_新书_骨语者/chapters/第04章_第一笔账.md', encoding='utf-8').read()
r_ours = report('我们 · 第04章（V0.38 新流程）', ours)

# 真人：西幻档随机 2 本，取中段 4000 字
genres = {}
for e in __import__('json').load(io.open('08_统计基线/题材标签_133本.json', encoding='utf-8')):
    genres[e['book']] = e.get('genre', '')
xh = [b for b, g in genres.items() if g == '西幻/异世界']
picked = []
for b in sorted(xh):
    p = os.path.join('04_语料/真人语料_网文133本', b)
    if os.path.exists(p):
        picked.append(p)
    if len(picked) >= 2:
        break
for p in picked:
    try:
        t = io.open(p, encoding='utf-8').read()
    except Exception:
        t = io.open(p, encoding='gb18030', errors='replace').read()
    report('真人 · %s（中段 4000 字）' % os.path.basename(p)[:24], t[60000:64000])

print('\n=== 对照 ===')
print('我们   ppl %.2f  nll_sd %.3f  意外token占比 %.1f%%  平淡token占比 %.1f%%'
      % (r_ours['ppl'], r_ours['sd'], r_ours['high'], r_ours['low']))
