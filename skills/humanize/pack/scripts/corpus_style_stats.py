# -*- coding: utf-8 -*-
"""全量语料风格统计 -> style_stats.json"""
import json, re, collections

DATA = 'E:/agent文章内容/corpus/train/webnovel_train_clean.jsonl'

rows = []
with open(DATA, encoding='utf-8') as f:
    for line in f:
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
print(f"chapters: {len(rows)}")

def analyze(text):
    paras = [p.strip() for p in re.split(r'\n+', text) if p.strip()]
    if not paras:
        return None
    p_lens = [len(p) for p in paras]
    sents = [s.strip() for s in re.split(r'[。！？!?…]+', text) if s.strip()]
    s_lens = [len(s) for s in sents]
    dlg = sum(1 for p in paras if ('“' in p or '「' in p))
    first_person = len(re.findall(r'我', text))
    third_person = len(re.findall(r'[^其他]他|她', text))
    return {
        'chars': len(text),
        'paras': len(paras),
        'para_avg': sum(p_lens)/len(p_lens),
        'para_short_pct': sum(1 for x in p_lens if x <= 30)/len(p_lens)*100,
        'sent_avg': sum(s_lens)/len(s_lens) if s_lens else 0,
        'sent_short_pct': sum(1 for x in s_lens if x <= 12)/len(s_lens)*100 if s_lens else 0,
        'sent_long_pct': sum(1 for x in s_lens if x >= 30)/len(s_lens)*100 if s_lens else 0,
        'dialog_para_pct': dlg/len(paras)*100,
        'wo_pct': first_person/max(first_person+third_person,1)*100,
        'q_end': 1 if text.rstrip()[-1:] in '？?' else 0,
        'ellipsis': text.count('……'),
        'exclaim': text.count('！'),
    }

stats = [s for r in rows if (s := analyze(r['text']))]
n = len(stats)
def avg(k): return round(sum(s[k] for s in stats)/n, 2)

# 人称分桶
fp = [s for s in stats if s['wo_pct'] > 70]
tp = [s for s in stats if s['wo_pct'] < 30]
def bucket(bs, name):
    if not bs: return {name: 'n/a'}
    m = len(bs)
    return {f'{name}_n': m, f'{name}_para_avg': round(sum(x['para_avg'] for x in bs)/m,1),
            f'{name}_sent_avg': round(sum(x['sent_avg'] for x in bs)/m,1),
            f'{name}_dialog': round(sum(x['dialog_para_pct'] for x in bs)/m,1)}

out = {
    'chapters': n,
    'books': len(set(r['book'] for r in rows)),
    'total_chars': sum(s['chars'] for s in stats),
    'chapter_chars_avg': avg('chars'),
    'para_per_chapter': avg('paras'),
    'para_len_avg': avg('para_avg'),
    'para_short_le30_pct': avg('para_short_pct'),
    'sent_len_avg': avg('sent_avg'),
    'sent_short_le12_pct': avg('sent_short_pct'),
    'sent_long_ge30_pct': avg('sent_long_pct'),
    'dialog_para_pct': avg('dialog_para_pct'),
    'wo_pct': avg('wo_pct'),
    'q_end_chapter_pct': round(sum(s['q_end'] for s in stats)/n*100, 1),
    'ellipsis_per_1k': round(avg('ellipsis')/avg('chars')*1000, 2),
    'exclaim_per_1k': round(avg('exclaim')/avg('chars')*1000, 2),
}
out.update(bucket(fp, 'first_person'))
out.update(bucket(tp, 'third_person'))

# 段落长度分布（直方图）
hist = collections.Counter()
for s in stats:
    pass
para_bins = collections.Counter()
for r in rows[:2000]:
    for p in re.split(r'\n+', r['text']):
        p = p.strip()
        if not p: continue
        L = len(p)
        b = '1-15' if L<=15 else '16-30' if L<=30 else '31-60' if L<=60 else '61-100' if L<=100 else '100+'
        para_bins[b] += 1
tot = sum(para_bins.values())
out['para_len_hist_pct'] = {k: round(v/tot*100,1) for k,v in sorted(para_bins.items())}

# 章节开头模式：对话开头 / 动作开头 / 环境开头
open_dlg = open_env = 0
sample = rows[:3000]
for r in sample:
    first = r['text'].strip().split('\n')[0]
    if '\u201c' in first or '「' in first: open_dlg += 1
    elif re.search(r'天|夜|晨|阳光|风|雨|屋|房|城|山|街|灯|月|日', first[:20]): open_env += 1
out['opening_dialog_pct'] = round(open_dlg/len(sample)*100,1)
out['opening_env_pct'] = round(open_env/len(sample)*100,1)

with open('E:/agent文章内容/style_stats.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False, indent=2))
