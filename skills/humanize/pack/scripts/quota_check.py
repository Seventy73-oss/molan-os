# -*- coding: utf-8 -*-
"""
quota_check.py — 配额账本核对（规则书V0.30 打分门7）

作者裁定（B2）：去掉全本总闸——改为"同一句式两次出现的最小章间隔"（间隔制，防限制长文）。

V0.30 修正（补齐"规则写了但门没生效"）：
  旧版对"章级配额"三项（金句癖/明喻引导词/verbatim）一律打印"（无正则，跳过）"——
  即门7的章级部分形同虚设。现在：
  1) 明喻引导词：按词分别计数（最长优先、不重叠），同一词单章 > 上限 即超支；
  2) 金句癖：对仗句／格言收尾词／"不是X是Y"独立成段／反差句 合计 ≤1/章
     （章尾钩子豁免一次——机器不判，输出原句交恶人编辑确认）。

V0.40.8 门精简（作者 2026-09-10 批准）：verbatim 逐字命中判据**已删除**——
  它依赖 --verbatim-list（历史上从未提供，四份报告全 [N/A]），判据永久空转；
  配额账本若仍含该组条目则**静默跳过**，不再输出任何 [N/A]/说明。
  将来若重开"改写模式"（有底本）再以按需判据提案恢复（提供 --verbatim-list 才判）。
  --verbatim-list / --require-verbatim 参数保留仅为兼容旧调用，不再产生输出。

用法：
  python quota_check.py --quota 11_skills包/配额账本.json --files "chapters/*.md"
超支 exit 2。
"""
import argparse
import glob
import json
import os
import re
import sys

# V0.33：控制台编码为 GBK 时中文/箭头字符会 UnicodeEncodeError 崩溃，统一强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PATTERNS = {
    "我以为的X/实际上的X": r'我以为的.{1,12}[:：]|实际上的.{1,12}[:：]',
    "不是A不是B是C": r'不是.{1,10}，?不是.{1,10}，?(而是|是)',
    "X是X_Y是Y对仗": r'(.{2,6})是\1.{0,4}(.{2,6})是\2',
    "格言收尾(总之/这就是/这才是/说到底/归根结底)": r'(总之|这就是|这才是|说到底|归根结底)',
    "好家伙": r'好家伙',
    "行吧": r'行吧',
    "这波": r'这波',
    "拿捏": r'拿捏',
    "看了很久/半天": r'看了(很久|半天)',
    "一行字": r'一行字',
    # V0.30.1：别X，Y 限定为祈使句（别必须起句），否则"别人的事""木簪别着"会误报
    "别X_Y": r'(?:^|[，。！？；：“”"\s])别.{1,6}，.{1,8}',
}

SIMILE_PATTERNS = {
    '如同': r'如同',
    '仿佛': r'仿佛',
    '宛如': r'宛如',
    '好像': r'好像',
    '好比': r'好比',
    '犹如': r'犹如',
    '似的': r'似的',
    # 裸"像"不是明喻引导词（"像在念案卷/像个做法的"是普通动词/介词），只认完整明喻结构
    '像…一样': r'像[^，。！？；]{0,12}(一样|似的|一般|那样|那般)',
}
GOLDEN_PATTERNS = [
    r'(.{2,6})是\1.{0,4}(.{2,6})是\2',        # X是X，Y是Y 对仗
    r'(总之|这就是|这才是|说到底|归根结底)',      # 格言收尾词
    r'^不是.{1,12}，?是.{1,20}$',              # "不是X是Y"独立成段
    r'仿佛只是做了一件不值一提的小事',            # 反差句
]


def count_similes(text):
    """按引导词分别计数；位置重叠时取最左最长命中，避免'好像'被同时计入'像…一样'"""
    spans = []
    for w, pat in SIMILE_PATTERNS.items():
        for m in re.finditer(pat, text):
            spans.append((m.start(), m.end(), w))
    spans.sort(key=lambda x: (x[0], -(x[1] - x[0])))
    counts, cur_end = {}, -1
    for s, e, w in spans:
        if s >= cur_end:
            counts[w] = counts.get(w, 0) + 1
            cur_end = e
    return counts


def golden_hits(text):
    hits = []
    for pat in GOLDEN_PATTERNS:
        for m in re.finditer(pat, text, re.M):
            hits.append(m.group(0)[:30])
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--quota', required=True)
    ap.add_argument('--files', nargs='+')
    ap.add_argument('--verbatim-list', default=None, dest='verbatim_list',
                    help='[已弃用 V0.40.8] verbatim 判据已删，参数仅保留兼容旧调用，不再产生输出')
    ap.add_argument('--require-verbatim', action='store_true', dest='require_verbatim',
                    help='[已弃用 V0.40.8] 同上，不再生效')
    args = ap.parse_args()

    quota = json.load(open(args.quota, encoding='utf-8'))['quotas']
    files = []
    for p in args.files or []:
        files.extend(sorted(glob.glob(p)))
    if not files:
        print('no files', file=sys.stderr)
        sys.exit(1)
    texts = [(os.path.basename(f), open(f, encoding='utf-8').read()) for f in files]
    full = '\n'.join(t for _, t in texts)
    print(f"扫描 {len(files)} 章，正文字数 {len(re.sub(chr(92) + 's', '', full))}")

    overruns, notes = [], []
    for group, items in quota.items():
        for name, q in items.items():
            # V0.40.8 门精简（作者 2026-09-10 批准）：verbatim 逐字命中判据已删除，
            # 配额账本若仍含该组条目则静默跳过（不打印、不计 [N/A]、不打回）。
            if name.startswith('verbatim'):
                continue
            # ---- 章级配额 ----
            if 'per_chapter' in q:
                if name.startswith('明喻引导词'):
                    worst, worst_f, worst_w = 0, '', ''
                    for fname, t in texts:
                        for w, c in count_similes(t).items():
                            if c > worst:
                                worst, worst_f, worst_w = c, fname, w
                    ok = worst <= q['per_chapter']
                    if not ok:
                        overruns.append((name, f"单章最高{worst}（'{worst_w}'，{worst_f}）> 限{q['per_chapter']}"))
                    print(f"[{group}] {name}: 单章最高{worst}（'{worst_w}'，{worst_f}）/限{q['per_chapter']} "
                          f"[{'超支' if not ok else 'OK'}]")
                elif name.startswith('金句癖'):
                    worst, worst_f, worst_txt = 0, '', []
                    for fname, t in texts:
                        hits = golden_hits(t)
                        if len(hits) > worst:
                            worst, worst_f, worst_txt = len(hits), fname, hits
                    ok = worst <= q['per_chapter']
                    if not ok:
                        overruns.append((name, f"单章最高{worst}（{worst_f}）：{worst_txt} > 限{q['per_chapter']}"))
                    print(f"[{group}] {name}: 单章最高{worst}/限{q['per_chapter']} "
                          f"[{'超支' if not ok else 'OK'}]"
                          + (f"  {worst_txt}" if worst else "")
                          + "  （章尾钩子豁免需恶人编辑确认）")
                else:
                    notes.append(f"{name}: 未实现章级核对")
                    print(f"[{group}] {name}: [未实现] 无对应核对逻辑")
                continue

            # ---- 间隔制 ----
            if 'interval_min' in q:
                pat = PATTERNS.get(name)
                if not pat:
                    notes.append(f"{name}: 无正则，跳过")
                    print(f"[{group}] {name}: [未实现] 无正则，跳过")
                    continue
                chs = [i for i, (_, t) in enumerate(texts, 1) if re.search(pat, t)]
                if len(chs) < 2:
                    print(f"[{group}] {name}: 出现{len(chs)}章 {chs} → OK（不构成间隔违例）")
                    continue
                gaps = [b - a for a, b in zip(chs, chs[1:])]
                ming = min(gaps)
                bad = ming < q['interval_min']
                if bad:
                    overruns.append((name, f"最小间隔{ming}章 < 下限{q['interval_min']}章，出现章号{chs}"))
                print(f"[{group}] {name}: 出现章号{chs} 最小间隔{ming}章/下限{q['interval_min']}章 "
                      f"[{'超支' if bad else 'OK'}]")

    if notes:
        print("\n[说明] " + "；".join(notes))
    if overruns:
        print("\n== 打回清单 ==")
        for name, why in overruns:
            print(f"  {name}: {why}")
        sys.exit(2)
    print("\n全部配额内，放行。")


if __name__ == '__main__':
    main()
