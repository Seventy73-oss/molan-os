# -*- coding: utf-8 -*-
"""
tail_check.py — 段落尾巴落位核对（规则书V0.30 第八节 / 打分门2）

为什么有这个工具：V0.29 把"段落两端"从惩罚对象改成资产（极短段=情绪崩口位、极长段=蓄势位），
但 style_metrics 只输出 para_short5/para_long120 两个计数，没有任何工具核对
"beat 标注的崩口位是否真落了极短段、蓄势位是否真有极长段、两尾是否由情绪驱动而非装饰"。
本工具补上这道门：机械部分全自动，情绪判断部分输出落点上下文交恶人编辑。

口径：
  段长 = 去掉空白后的字符数（含标点），与评分器口径一致；
  极短段 ≤ --short-max（默认5）；极长段 ≥ --long-min（默认120）；
  极短段**数量**应落在 [--count-min, --count-max]（默认1~3，规则书第八节1）；
  全章 ≤30 字段落占比 >80% = 抽搐（没身体）；
  >100 字段落占比 >30% = 全文注水外护栏；
  后半章段数落差 ≤15%（模型后半退化的机械检测）。

用法：
  python tail_check.py --files "chapters/*.md"
  python tail_check.py --files "chapters/*.md" --beats 04_beatsheet补丁.md
  python tail_check.py --files "chapters/*.md" --beats beats.md --allow-missing-beat --out tail_report.json

退出码：0=通过；2=有打回项；1=用法/输入错误。
"""
import argparse
import glob
import json
import os
import re
import sys
import statistics as st

# V0.33：控制台编码为 GBK 时中文/箭头字符会 UnicodeEncodeError 崩溃，统一强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

CHAPTER_HEAD = re.compile(r'^\s*#{0,4}\s*第\s*([0-9]+|[一二三四五六七八九十百千两零〇]+)\s*章')
BEAT_FIELD = re.compile(r'^\s*[-*+]?\s*(情绪崩口位|蓄势位|章节标题风格)\s*[:：]\s*(.*)$')
FILE_CH = re.compile(r'第\s*([0-9]+|[一二三四五六七八九十百千两零〇]+)\s*章')
CN_NUM = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
          '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}


def cn2int(s):
    s = s.strip()
    if s.isdigit():
        return int(s)
    if s.startswith('十'):
        s = '一' + s
    total = 0
    for ch in s:
        if ch in CN_NUM:
            total += CN_NUM[ch]
        elif ch == '十':
            total = (total or 1) * 10
        else:
            return None
    return total or None


def load_paras(fp):
    """返回正文段落列表（剔除标题行、分隔线、引用块）"""
    raw = open(fp, encoding='utf-8').read().replace('\r\n', '\n').replace('\r', '\n')
    blocks, cur = [], []
    for ln in raw.split('\n'):
        s = ln.strip()
        if not s:
            if cur:
                blocks.append(' '.join(cur))
                cur = []
            continue
        if s.startswith('#') or s.startswith('---') or s.startswith('***') or s.startswith('>'):
            if cur:
                blocks.append(' '.join(cur))
                cur = []
            continue
        cur.append(s)
    if cur:
        blocks.append(' '.join(cur))
    return blocks


def plen(p):
    return len(re.sub(r'\s', '', p))


def parse_beats(fp):
    """解析 beat sheet 里每章的 情绪崩口位/蓄势位（无则记 None）"""
    beats = {}
    cur = None
    for ln in open(fp, encoding='utf-8').read().split('\n'):
        m = CHAPTER_HEAD.match(ln)
        if m:
            n = cn2int(m.group(1))
            if n is not None:
                cur = n
                beats.setdefault(cur, {})
            continue
        m = BEAT_FIELD.match(ln)
        if m and cur is not None:
            beats[cur][m.group(1)] = m.group(2).strip()
    return beats


def check_chapter(name, paras, beat, args):
    lens = [plen(p) for p in paras]
    n = len(lens)
    shorts = [(i + 1, paras[i], lens[i]) for i in range(n) if lens[i] <= args.short_max]
    longs = [(i + 1, paras[i], lens[i]) for i in range(n) if lens[i] >= args.long_min]
    mean_len = st.mean(lens) if lens else 0
    cv = round(st.pstdev(lens) / mean_len, 3) if mean_len else 0.0
    frac30 = sum(1 for L in lens if L <= 30) / n if n else 0
    frac100 = sum(1 for L in lens if L > 100) / n if n else 0
    half = n // 2
    first, second = half, n - half
    drift = abs(second - first) / first if first else 0.0

    fails = []
    if not (args.count_min <= len(shorts) <= args.count_max):
        fails.append(f"极短段{len(shorts)}个，应落在[{args.count_min},{args.count_max}]")
    if len(longs) < args.long_min_count:
        fails.append(f"极长段{len(longs)}个，应≥{args.long_min_count}")
    if frac30 > args.churn_max:
        fails.append(f"≤30字段落占比{frac30:.1%}> {args.churn_max:.0%}（抽搐，没身体）")
    if drift > args.drift_max:
        fails.append(f"后半段数落差{drift:.1%}> {args.drift_max:.0%}（后半退化）")
    if frac100 > args.longfrac_max:
        fails.append(f">100字段落占比{frac100:.1%}> {args.longfrac_max:.0%}（注水外护栏）")

    beat_note = None
    if args.beats is not None:
        has_short = bool(beat and beat.get('情绪崩口位'))
        has_long = bool(beat and beat.get('蓄势位'))
        if not (has_short and has_long):
            miss = [k for k in ('情绪崩口位', '蓄势位')
                    if not (beat and beat.get(k))]
            msg = f"beat缺字段：{'、'.join(miss)}"
            if args.allow_missing_beat:
                beat_note = msg + "（已按 --allow-missing-beat 降级为提醒）"
            else:
                fails.append(msg)

    return {
        "chapter": name,
        "paras": n,
        "mean_para_len": round(mean_len, 1),
        "para_cv": cv,
        "short_count": len(shorts),
        "long_count": len(longs),
        "frac_le30": round(frac30, 3),
        "frac_gt100": round(frac100, 3),
        "half_drift": round(drift, 3),
        "shorts": [{"para": i, "len": L, "text": t[:40],
                    "prev": paras[i - 2][-20:] if i >= 2 else ""} for i, t, L in shorts],
        "longs": [{"para": i, "len": L, "text": t[:30]} for i, t, L in longs],
        "beat": beat or {},
        "beat_note": beat_note,
        "fails": fails,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', nargs='+', required=True)
    ap.add_argument('--beats', default=None, help='beat sheet 文件（解析情绪崩口位/蓄势位）')
    ap.add_argument('--short-max', type=int, default=5, help='极短段长度上限（字）')
    ap.add_argument('--count-min', type=int, default=1, dest='count_min',
                    help='极短段数量下限（默认1）')
    ap.add_argument('--count-max', type=int, default=3, dest='count_max',
                    help='极短段数量上限（默认3，规则书第八节1）')
    ap.add_argument('--long-min', type=int, default=120)
    ap.add_argument('--long-min-count', type=int, default=1, dest='long_min_count')
    ap.add_argument('--churn-max', type=float, default=0.92, help='≤30字段落占比上限（V0.39：0.80×1.15）')
    ap.add_argument('--drift-max', type=float, default=0.17, help='后半段数落差上限（V0.39：0.15×1.15）')
    ap.add_argument('--longfrac-max', type=float, default=0.35, dest='longfrac_max',
                    help='>100字段落占比上限（注水外护栏；V0.39：0.30×1.15）')
    ap.add_argument('--allow-missing-beat', action='store_true', dest='allow_missing_beat',
                    help='beat缺崩口位/蓄势位字段时只提醒不打回（历史稿复跑用）')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    files = []
    for p in args.files:
        files.extend(sorted(glob.glob(p)))
    if not files:
        print('no files', file=sys.stderr)
        sys.exit(1)

    beats = parse_beats(args.beats) if args.beats else {}
    rows, all_fails = [], []
    for fp in files:
        name = os.path.basename(fp)
        m = FILE_CH.search(name)
        cno = cn2int(m.group(1)) if m else None
        beat = beats.get(cno)
        row = check_chapter(name, load_paras(fp), beat, args)
        rows.append(row)
        if row['fails']:
            all_fails.append((name, row['fails']))

    print(f"扫描 {len(files)} 章  |  极短段≤{args.short_max}字  极长段≥{args.long_min}字"
          + (f"  |  beat: {os.path.basename(args.beats)}" if args.beats else "  |  beat: 未提供"))
    print()
    for r in rows:
        tag = "OK " if not r['fails'] else "打回"
        print(f"[{tag}] {r['chapter']}  段数{r['paras']} 平均{r['mean_para_len']}字 "
              f"para_cv={r['para_cv']}")
        print(f"        极短段 {r['short_count']} 个 / 极长段 {r['long_count']} 个 | "
              f"≤30字占{r['frac_le30']:.0%} >100字占{r['frac_gt100']:.0%} | "
              f"后半落差{r['half_drift']:.1%}")
        for s in r['shorts']:
            print(f"        · 短 p{s['para']}({s['len']}字) 「{s['text']}」"
                  + (f"  ← 前段尾「…{s['prev']}」" if s['prev'] else ""))
        for s in r['longs']:
            print(f"        · 长 p{s['para']}({s['len']}字) 「{s['text']}…」")
        if r['beat_note']:
            print(f"        ! {r['beat_note']}")
        for f in r['fails']:
            print(f"        × {f}")
    if all_fails:
        print("\n== 打回清单 ==")
        for name, fs in all_fails:
            for f in fs:
                print(f"  {name}: {f}")
    else:
        print("\n尾巴条款核对全部通过（落点情绪由恶人编辑复核）。")

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump({"rows": rows}, f, ensure_ascii=False, indent=1)
        print(f"\n已写入 {args.out}")
    sys.exit(2 if all_fails else 0)


if __name__ == '__main__':
    main()
