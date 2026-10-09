# -*- coding: utf-8 -*-
"""
去 AI 味 · 规则层修复（确定性，无模型参与）

针对 style-pack/style-fingerprint.md 官方基线做排版级修复：
  1. 段落合并  —— 把碎段落合并回目标分布（平均 37.6 字）
  2. 省略号治理 —— 降到 1.62/千字
  3. 破折号治理 —— 语料几乎不用，全部清除
  4. 对话配比   —— 让对话段占比回到 31.2%（第一人称 38.3%）

设计要点：
  - 合并时按"引号衔接"规则处理，保证对话不被拆坏：
      两段都是纯对话 → 消掉中间的闭合+开放引号，拼成连续话语
      对话 + 动作 + 对话 → 保留引号，形成网文标准的"话—动作—话"一段式
  - 短叙述段可以并入紧随的对话段（网文常见排版），用来把对话段占比压回基线

用法：
  python deai_style.py input.txt output.md
  python deai_style.py input.txt --target_dialog 0.38 --para_target 38
"""
import re, sys, argparse
sys.stdout.reconfigure(encoding='utf-8')

# 官方基线（style-fingerprint.md）
BASE_PARA = 37.6
BASE_DIALOG = 0.312          # 全体 31.2%，第一人称 38.3%
BASE_ELLIPSIS = 1.62         # 每千字

Q = '"'


def is_dialog(p):
    return p.startswith(Q)


def quote_closed(s):
    return s.count(Q) % 2 == 0


def join_para(a, b):
    """按引号衔接规则拼接两段"""
    if a.rstrip().endswith(Q) and b.lstrip().startswith(Q):
        # 两段都是对话 → 消掉中间引号，拼成连续话语
        return a.rstrip()[:-1] + b.lstrip()[1:]
    return a.rstrip() + b.lstrip()


def merge_paragraphs(paras, para_target=38, para_max=72,
                     short_narr_to_dialog=18, dialog_merge=True):
    """
    para_target         : 叙述段累积到该长度即断段
    para_max            : 硬上限
    short_narr_to_dialog: 短于此长度的叙述段并入紧随的对话段
    """
    out, buf = [], ''
    in_dialog = False

    for p in paras:
        p = p.strip()
        if not p:
            continue

        if not buf:
            buf = p
            in_dialog = is_dialog(p)
            continue

        if is_dialog(p):
            if in_dialog:
                buf = join_para(buf, p)                      # 连续对话 → 合并
            elif len(buf) <= short_narr_to_dialog and dialog_merge:
                buf = join_para(buf, p)                      # 短动作 + 对话 → 一段
                in_dialog = True
            else:
                out.append(buf)                              # 动作独立成段，开新对话段
                buf = p
                in_dialog = True
        else:
            if in_dialog and not quote_closed(buf):
                buf = join_para(buf, p)                      # 对话未闭合 → 接下去
            elif in_dialog and len(buf) < para_target:
                buf = join_para(buf, p)                      # 对话后接动作描写
                in_dialog = False
            else:
                buf = join_para(buf, p)
                in_dialog = False

        if in_dialog and quote_closed(buf) and len(buf) >= para_target:
            out.append(buf); buf = ''; in_dialog = False
        elif len(buf) >= para_max:
            out.append(buf); buf = ''; in_dialog = False

    if buf:
        out.append(buf)
    return out


def fix_ellipsis(paras, per_k=BASE_ELLIPSIS, keep_in_dialog=True):
    """把省略号降到目标密度：优先保留对话中的（表示话语停顿），叙述中的改回句号"""
    total = sum(len(p) for p in paras)
    quota = max(1, int(total / 1000 * per_k))

    # 先统计并排序：对话中的优先保留
    idx_dialog, idx_narr = [], []
    for i, p in enumerate(paras):
        if '……' in p:
            (idx_dialog if is_dialog(p) else idx_narr).append(i)

    keep = set()
    for i in idx_dialog:
        if len(keep) < quota:
            keep.add(i)
    for i in idx_narr:
        if len(keep) < quota:
            keep.add(i)

    out = []
    for i, p in enumerate(paras):
        if '……' in p and i not in keep:
            # 省略号 → 句号（保留话语的停顿感用逗号替代更自然）
            p = p.replace('？……', '？').replace('！……', '！')
            p = re.sub(r'([^。！？])……', r'\1。', p)
            p = p.replace('……', '。')
            p = re.sub(r'。{2,}', '。', p)
        out.append(p)
    return out


def fix_dash(paras):
    """破折号：语料几乎不用。话被打断的破折号直接连回去"""
    out = []
    for p in paras:
        p = p.replace('——', '')
        p = re.sub(r'\s{2,}', ' ', p)
        out.append(p.strip())
    return out


def stats(paras):
    L = [len(p) for p in paras]
    n = len(L)
    chars = sum(L)
    text = '\n'.join(paras)
    return {
        '段数': n,
        '平均段长': round(sum(L) / n, 1),
        '1-15字%': round(sum(1 for x in L if x <= 15) / n * 100, 1),
        '16-30字%': round(sum(1 for x in L if 16 <= x <= 30) / n * 100, 1),
        '31-60字%': round(sum(1 for x in L if 31 <= x <= 60) / n * 100, 1),
        '61-100字%': round(sum(1 for x in L if 61 <= x <= 100) / n * 100, 1),
        '>100字%': round(sum(1 for x in L if x > 100) / n * 100, 1),
        '对话段%': round(sum(1 for p in paras if is_dialog(p)) / n * 100, 1),
        '省略号/千字': round(text.count('……') / chars * 1000, 2),
        '破折号/千字': round(text.count('——') / chars * 1000, 2),
        '字符数': chars,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst', nargs='?')
    ap.add_argument('--para_target', type=int, default=38)
    ap.add_argument('--para_max', type=int, default=72)
    ap.add_argument('--short_narr', type=int, default=18)
    ap.add_argument('--no_dialog_merge', action='store_true')
    args = ap.parse_args()

    text = open(args.src, encoding='utf-8').read()
    paras = [p.strip() for p in text.split('\n') if p.strip()]

    before = stats(paras)
    cur = merge_paragraphs(paras, args.para_target, args.para_max,
                           args.short_narr, not args.no_dialog_merge)
    cur = fix_ellipsis(cur)
    cur = fix_dash(cur)
    after = stats(cur)

    keys = ['段数', '平均段长', '1-15字%', '16-30字%', '31-60字%', '61-100字%',
            '>100字%', '对话段%', '省略号/千字', '破折号/千字', '字符数']
    base = {'平均段长': 37.6, '1-15字%': 25.5, '16-30字%': 30.6, '31-60字%': 32.3,
            '61-100字%': 9.3, '>100字%': 2.4, '对话段%': 31.2,
            '省略号/千字': 1.62, '破折号/千字': 0.0}

    print(f'{"指标":<12}{"修复前":>10}{"修复后":>10}{"官方基线":>10}')
    print('-' * 42)
    for k in keys:
        b = base.get(k, '—')
        print(f'{k:<12}{str(before[k]):>10}{str(after[k]):>10}{str(b):>10}')

    out_text = '\n\n'.join(cur)
    if args.dst:
        open(args.dst, 'w', encoding='utf-8').write(out_text)
        print(f'\n[done] 已写出 -> {args.dst}')


if __name__ == '__main__':
    main()
