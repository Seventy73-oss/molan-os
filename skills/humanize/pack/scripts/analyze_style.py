# -*- coding: utf-8 -*-
"""
风格指纹分析：对任意中文文本计算可量化风格指标。
用于对比 训练集语料(人类网文) / LoRA生成 / 底座生成 / 待测文本。
"""
import os, re, sys, json, random, argparse
sys.stdout.reconfigure(encoding='utf-8')

# 具体实体词：货币、度量、食物、地名标记等 —— 衡量"名词具体度"
CONCRETE = r'(?:铜币|银币|金币|灵石|元|块|两|斤|枚|米|公里|里地|度|岁|个月|铜板|馒头|面条|酒|茶|街|巷|城|镇|村|客栈|酒楼)'
# 情绪标签堆叠："有无奈，有震惊，还有…"
EMO_STACK = r'[有是][^，。！？]{1,6}[，、][^，。！？]{1,6}[，、]还有?[^，。！？]{1,6}'
# "不是X。是Y。" 否定-修正模板
NEG_CORR = r'不是[^。！？\n]{0,20}[。！？\n]\s*是[^。！？\n]{0,20}'


def load_text(path, limit=None):
    p = path.lower()
    if p.endswith('.jsonl'):
        outs = []
        with open(path, encoding='utf-8') as f:
            for i, line in enumerate(f):
                if limit and i >= limit:
                    break
                try:
                    outs.append(json.loads(line).get('output', ''))
                except Exception:
                    pass
        return '\n'.join(outs)
    with open(path, encoding='utf-8') as f:
        return f.read()


def stats(name, text):
    t = text
    paras = [x.strip() for x in t.split('\n') if x.strip()]
    if not paras:
        return None
    L = [len(x) for x in paras]
    L_sorted = sorted(L)
    n = len(L)
    chars = sum(L)

    sents = [s for s in re.split(r'[。！？…\n]', t) if s.strip()]
    per1k = lambda v: round(v / chars * 1000, 2)

    def has(pat):
        return len(re.findall(pat, t))

    return {
        '样本': name,
        '字符数': chars,
        '段落数': n,
        '平均段长': round(sum(L) / n, 1),
        '中位段长': L_sorted[n // 2],
        '最长段': max(L),
        '≤10字段落%': round(sum(1 for x in L if x <= 10) / n * 100, 1),
        '>50字段落%': round(sum(1 for x in L if x > 50) / n * 100, 1),
        '>100字段落%': round(sum(1 for x in L if x > 100) / n * 100, 1),
        '平均句长': round(sum(len(s) for s in sents) / max(len(sents), 1), 1),
        '对话段占比%': round(sum(1 for x in paras if x.startswith(('“', '"', '「'))) / n * 100, 1),
        '具体名词/千字': per1k(has(CONCRETE)),
        '否定修正/千字': per1k(has(NEG_CORR)),
        '情绪堆叠/千字': per1k(has(EMO_STACK)),
        '省略号/千字': per1k(t.count('……')),
        '破折号/千字': per1k(t.count('——')),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+', help='格式 名称=路径')
    ap.add_argument('--jsonl_limit', type=int, default=600)
    args = ap.parse_args()

    rows = []
    for spec in args.files:
        name, path = spec.split('=', 1)
        if not os.path.exists(path):
            print(f'[skip] {name}: {path} 不存在')
            continue
        txt = load_text(path, args.jsonl_limit)
        r = stats(name, txt)
        if r:
            rows.append(r)

    keys = list(rows[0].keys())
    w = max(len(k) for k in keys) + 2
    print('指标'.ljust(w) + ''.join(str(r['样本']).rjust(16) for r in rows))
    print('-' * (w + 16 * len(rows)))
    for k in keys:
        if k == '样本':
            continue
        line = k.ljust(w)
        for r in rows:
            line += str(r[k]).rjust(16)
        print(line)


if __name__ == '__main__':
    main()
