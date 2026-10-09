# -*- coding: utf-8 -*-
"""
构造「改写」配对训练数据。

思路：语料原文就是"目标风格"（平均段长 37.6 字）。用规则把它**退化**成大模型常见的
短段癌 AI 腔（平均段长 ~14 字、省略号 6.5/千字、短句过半），配成
    input  = 退化版（待改写）
    output = 语料原文（改写目标）
模型学到的就是纯粹的排版级风格变换：合并碎段落、去掉多余省略号、把句子接长。
所有文字内容保持不变，只动段落切分和少量标点 —— 保证"改写"不需要创造力，只需要风格迁移。

退化参数来自对 output.txt（大模型生成的待改原材料）的实测统计。
"""
import os, re, json, random, argparse, sys
sys.stdout.reconfigure(encoding='utf-8')

DATA = 'E:/agent文章内容/corpus/train/webnovel_alpaca.jsonl'
OUT = 'E:/agent文章内容/corpus/train/webnovel_revision.jsonl'

INSTR_TMPL = "请把下面这段小说文字改写成地道的网文风格。保持剧情、人物和对话内容完全不变，只调整段落节奏、句子长度和语言表达。\n\n"

# 退化目标（实测自 output.txt）
TARGET = {'para_len': 14.0, 'ellipsis_per_k': 6.5}


def split_frags(p):
    """
    只在标点处切分，绝不切断词——真实的短段癌是"长句按逗号拆成子句"，
    不是把词从中间劈开。切完再把过短碎片（<5字）并回相邻片段。
    """
    frags = re.findall(r'[^，。！？；：]+[，。！？；：]?', p)
    frags = [f for f in frags if f.strip()]
    merged = []
    for f in frags:
        if merged and len(merged[-1].strip()) < 5:
            merged[-1] += f
        elif len(f.strip()) < 5 and merged:
            merged[-1] += f
        else:
            merged.append(f)
    return [f for f in merged if f.strip()]


def degrade(text, rnd, target_para=11.0, ellipsis_per_k=6.5, break_p=0.45):
    """把正常段落切成碎段落 + 注入省略号，内容一字不改"""
    paras = [p.strip() for p in text.split('\n') if p.strip()]
    out = []
    for p in paras:
        frags = split_frags(p)
        if not frags:
            out.append(p)
            continue
        buf = ''
        for f in frags:
            buf += f
            if len(buf) >= target_para or rnd.random() < break_p:
                out.append(buf.strip())
                buf = ''
        if buf.strip():
            out.append(buf.strip())

    total = max(sum(len(x) for x in out), 1)
    cur = sum(x.count('……') for x in out)          # 语料本身就有省略号，补足而非叠加
    need = max(0, int(total / 1000 * ellipsis_per_k) - cur)
    cand = [i for i, s in enumerate(out)
            if s.rstrip().endswith(('。', '！', '？')) and '……' not in s and len(s) <= 30]
    if cand and need:
        for i in rnd.sample(cand, min(need, len(cand))):
            out[i] = out[i].rstrip()[:-1] + '……'
    return '\n\n'.join(out)


def stats(text):
    paras = [p.strip() for p in text.split('\n') if p.strip()]
    if not paras:
        return None
    L = [len(p) for p in paras]
    chars = sum(L)
    return {
        '段数': len(L),
        '平均段长': round(sum(L) / len(L), 1),
        '1-15字%': round(sum(1 for x in L if x <= 15) / len(L) * 100, 1),
        '省略号/千字': round(text.count('……') / chars * 1000, 2),
        '字符数': chars,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max_samples', type=int, default=None)
    ap.add_argument('--min_chars', type=int, default=800, help='原文最短字数')
    ap.add_argument('--max_chars', type=int, default=1600, help='原文截取上限')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--preview', type=int, default=0, help='打印前 N 条对照，不写文件')
    args = ap.parse_args()

    rnd = random.Random(args.seed)
    n_in = n_out = 0
    fout = None if args.preview else open(OUT, 'w', encoding='utf-8')

    with open(DATA, encoding='utf-8') as f:
        for line in f:
            if args.max_samples and n_out >= args.max_samples:
                break
            r = json.loads(line)
            orig = r['output'].strip()
            if len(orig) < args.min_chars:
                continue
            orig = orig[:args.max_chars]
            # 截到段落边界，避免半截话
            if '\n' in orig:
                orig = orig[:orig.rfind('\n')].strip()
            if len(orig) < args.min_chars:
                continue

            n_in += 1
            deg = degrade(orig, rnd)

            if args.preview and n_out < args.preview:
                print(f'===== 样本 {n_out+1} =====')
                print('--- 退化版(input) 前 400 字 ---')
                print(deg[:400])
                print('--- 原文(output) 前 400 字 ---')
                print(orig[:400])
                print('--- 统计 ---')
                print('  退化版', stats(deg))
                print('  原文  ', stats(orig))
                print()

            if fout:
                fout.write(json.dumps({
                    'instruction': INSTR_TMPL + deg,
                    'output': orig,
                }, ensure_ascii=False) + '\n')
            n_out += 1

    if fout:
        fout.close()
        print(f'[done] 读入 {n_in} 章，产出 {n_out} 条配对 -> {OUT}')
        sz = os.path.getsize(OUT) / 1024 / 1024
        print(f'[done] 文件大小 {sz:.1f} MB')
    else:
        print(f'[preview] 共处理 {n_out} 条')


if __name__ == '__main__':
    main()
