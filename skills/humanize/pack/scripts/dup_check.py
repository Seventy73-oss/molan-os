# -*- coding: utf-8 -*-
"""
dup_check.py — 跨章复制级重复 + 同构复述检测（规则书V0.28 工具）
用法：
  python dup_check.py <文件1> <文件2> ... [--min-len 10] [--sim 0.85]
                      [--whitelist 白名单.txt] [--out report.json]
检测：
  A. 精确重复句：规范化后长度≥min-len的句子出现≥2次（白名单跳过）
  B. 高相似句对：长度相近句 similarity≥sim（V0.40.8 降级为报警，不阻断）
  C. 同构复述：不同句子共享相同句首key（≥5个规范字）且非高相似——
     实测教训：ch14"三天下来，众筹的…"式换尾句，sim抓不到，句首检测才抓得到

V0.40.8 门精简（作者 2026-09-10 批准）：
  1) D 项"句式模板频率"打印已删除——它与 quota_check.py 的 PATTERNS 逐条重复、
     只打印不判（判定职能由 quota 间隔制承担），删除的只是重复印刷。
  2) B 项高相似句对（sim≥0.85）由打回**降级为报警**：3 次实测 0 命中、无回归用例，
     命中域与 A（全等）/C（同句首）/E（句尾）/F（10 字子串）重叠。
"""
import argparse, glob, json, re, sys, os
from difflib import SequenceMatcher
from collections import defaultdict

# V0.33：控制台编码为 GBK 时，↔ 等字符会 UnicodeEncodeError 直接崩溃
# （实测：dup_check 打出同构组时崩溃，退出码被掩盖）。统一强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

SENT_SPLIT = re.compile(r'[。！？!?…\n]+')
# V0.30：规范式补上中文弯引号/单引号（旧版只去ASCII引号，导致"元宝说"式对白引子
# 被误判成40组同构复述——噪声淹没真同构）
_PUNCT = ('\u3000，、；：:!？?'
          '\u201c\u201d\u2018\u2019「」『』'
          '（）()《》〈〉【】[]{}'
          '\u2014\u2013-~\u2026.')
NORM = re.compile('[\\s' + re.escape(_PUNCT) + ']+')

def norm(s):
    return NORM.sub('', s)

def sentences(text):
    out = []
    for raw in SENT_SPLIT.split(text):
        n = norm(raw)
        if len(n) >= 4:
            out.append((raw.strip(), n))
    return out


def short(fp):
    return os.path.basename(fp)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--min-len', type=int, default=10)
    ap.add_argument('--sim', type=float, default=0.85)
    ap.add_argument('--struct-sim', type=float, default=0.5, dest='struct_sim',
                    help='同构复述打回阈值：同句首key组内最高相似度≥此值即打回（默认0.5）')
    ap.add_argument('--whitelist', default=None, help='白名单文件：每行一个句子（原文即可），精确重复检测跳过')
    ap.add_argument('--no-tail-reuse', action='store_false', dest='tail_reuse',
                    help='关闭 E项 跨章句尾短语复用检测（默认开启；作者已批准 V0.35）')
    ap.add_argument('--tables', default=None,
                    help='设定表工作簿：读「伏笔钩子台账」豁免首尾呼应/收钩子（E项）')
    ap.add_argument('--no-phrase-reuse', action='store_false', dest='phrase_reuse',
                    help='关闭 F项 跨章长短语复用（默认开启，N15 信息回调必须变奏）')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    files = []
    for p in args.paths:
        files.extend(sorted(glob.glob(p)))
    if not files:
        print('no files', file=sys.stderr); sys.exit(1)

    wl = set()
    if args.whitelist and glob.glob(args.whitelist):
        for wfp in glob.glob(args.whitelist):
            for line in open(wfp, encoding='utf-8'):
                n = norm(line.strip())
                if len(n) >= 4:
                    wl.add(n)

    all_s = []
    for fp in files:
        t = open(fp, encoding='utf-8').read()
        for s, n in sentences(t):
            all_s.append((fp, s, n))

    # A. 精确重复
    exact = defaultdict(list)
    for fp, s, n in all_s:
        if len(n) >= args.min_len:
            exact[n].append((fp, s))
    dup_exact = [{'text': v[0][1], 'count': len(v),
                  'where': [short(f) for f, _ in v[:6]]}
                 for n, v in exact.items() if len(v) >= 2 and n not in wl]
    dup_exact.sort(key=lambda d: -d['count'])

    # B. 高相似句对
    pool = [(fp, s, n) for fp, s, n in all_s if len(n) >= args.min_len and s not in wl]
    pool.sort(key=lambda x: x[2])
    sim_dups = []
    for i in range(len(pool)):
        f1, s1, n1 = pool[i]
        for j in range(i+1, len(pool)):
            f2, s2, n2 = pool[j]
            if len(n2) - len(n1) > 6:
                break
            if abs(len(n1)-len(n2)) <= 6:
                if n1 in wl or n2 in wl:
                    continue
                r = SequenceMatcher(None, n1, n2).ratio()
                if r >= args.sim:
                    sim_dups.append({'a': s1[:40], 'b': s2[:40], 'ratio': round(r, 2),
                                     'fa': short(f1), 'fb': short(f2)})
    sim_dups = sim_dups[:40]

    # C. 同构复述（句首key相同、非同一句、且非高相似）
    open_map = defaultdict(list)
    for fp, s, n in all_s:
        if len(n) >= 10 and s not in wl:
            open_map[n[:5]].append((fp, s))
    dup_open = []
    for k, v in open_map.items():
        if len(v) < 2:
            continue
        pairs = []
        for i in range(len(v)):
            for j in range(i+1, len(v)):
                if v[i][1] == v[j][1]:
                    continue
                r = SequenceMatcher(None, norm(v[i][1]), norm(v[j][1])).ratio()
                if r < args.sim:
                    pairs.append((v[i], v[j], round(r, 2)))
        if pairs:
            worst = max(p[2] for p in pairs)
            dup_open.append({'key': k, 'count': len(v),
                             'examples': [s[:36] for _, s in v[:4]],
                             'where': [short(f) for f, _ in v[:5]],
                             'worst_sim': worst,
                             'violation': worst >= args.struct_sim,
                             'pairs': [{'a': a[1][:30], 'b': b[1][:30], 'ratio': r} for a, b, r in pairs[:3]]})
    dup_open.sort(key=lambda d: (-d['violation'], -d['count']))
    struct_bad = [d for d in dup_open if d['violation']]

    # F. 跨章长短语复用（V0.36，N15 信息回调必须变奏）
    # 规则书第十节：信息回调（伏笔呼应/前情提及）必须改写措辞，逐字复读=复读指纹。
    # 判据：叙述层任意 **10 字以上**连续片段跨章重复 → 打回（母题白名单除外）。
    # 与 E项的区别：E项只查句尾 6 字；F项查句内任意 10+ 字（更接近"复读"定义）。
    PHRASE_N = 10
    ph_chaps = defaultdict(set)
    ph_ctx = defaultdict(list)
    if args.phrase_reuse:
        for ci, fp in enumerate(files, 1):
            for s, n in sentences(open(fp, encoding='utf-8').read()):
                if any(q in s for q in '“”「」『』'):
                    continue
                if len(n) < PHRASE_N:
                    continue
                for i in range(len(n) - PHRASE_N + 1):
                    ph = n[i:i + PHRASE_N]
                    ph_chaps[ph].add(ci)
                    if len(ph_ctx[ph]) < 3:
                        ph_ctx[ph].append((ci, s[:40]))
    ph_bad = []
    for ph, cs in sorted(ph_chaps.items(), key=lambda x: (-len(x[0]), x[0])):
        if len(cs) < 2:
            continue
        if any(ph in w for w in wl):
            continue
        # 去重：同章号组且与已报片段有 ≥8 字公共子串 → 同一处重复，只报一次
        cs2 = sorted(cs)
        dup = False
        for kept_ph, kept_cs in ph_bad:
            if kept_cs != cs2:
                continue
            m = SequenceMatcher(None, ph, kept_ph).find_longest_match(
                0, len(ph), 0, len(kept_ph))
            if m.size >= PHRASE_N - 3:
                dup = True
                break
        if dup:
            continue
        ph_bad.append((ph, cs2))
    ph_bad.sort(key=lambda x: (-len(x[1]), x[0]))

    # E. 跨章句尾短语复用（V0.34）
    # 为什么新增：实测《骨语者》第2章「…月亮露出来，照着底下那一排排坟坑，白的，整整齐齐。」
    # 与第3章「…月亮很亮，照得坟坑一排一排，白的，整整齐齐。」整句相似度只有 0.78，
    # A/B/C 三项全部漏掉。但两句**句尾完全相同**——叙述句的落点短语跨章复用，
    # 是「同一支笔在复用意象」的强证据，而且句尾短、命中率远高于整句相似度。
    #
    # 试过但否掉的方案（记录在案，避免重走）：
    #   · 裸 6-gram 跨章检测：打回 65 组，几乎全是「同一件东西被反复提到」
    #     （木板/第九行/值班房墙上那块木板），属正常回指；
    #   · 加专名/道具/术语豁免后仍剩 45 组，说明整句级 n-gram 对本任务无判别力。
    # 结论：**只查句尾**。
    TAIL_N = 6
    QUOTE_CHARS = '“”「」『』'
    tail_chaps = defaultdict(set)
    tail_ctx = defaultdict(list)
    for ci, fp in enumerate(files, 1):
        for s, n in sentences(open(fp, encoding='utf-8').read()):
            if any(q in s for q in QUOTE_CHARS):
                continue          # 只查叙述层，对白里的重复可能是人物语癖
            if len(n) < TAIL_N:
                continue
            t = n[-TAIL_N:]
            tail_chaps[t].add(ci)
            if len(tail_ctx[t]) < 3:
                tail_ctx[t].append((ci, s[:40]))
    tail_bad = []
    exempt_pairs, exempt_phrases = set(), set()
    if args.tail_reuse:
        # 豁免（作者裁定 V0.35）：句尾复用必须验证是否为「首尾呼应」或「收钩子」——
        # 依据「伏笔钩子台账」：埋设章↔回收章 配对 = 首尾呼应/收钩子；
        # 类型=母题回调 且 回收方式=逐字 的「内容」短语，直接豁免。
        tabs_path = args.tables
        if not tabs_path:
            try:
                from _tables import find_tables
                cands = find_tables(os.path.dirname(os.path.abspath(files[0])))
                tabs_path = cands[0] if cands else None
            except Exception:
                tabs_path = None
        if tabs_path and os.path.exists(tabs_path):
            try:
                from _tables import chap_num, col, load_tables, rows_of
                tabs = load_tables(tabs_path)
                for r in rows_of(tabs, '伏笔钩子台账'):
                    bury = chap_num(col(r, '埋设章'))
                    back = chap_num(col(r, '回收章'))
                    if bury and back:
                        for a in bury:
                            for b in back:
                                exempt_pairs.add((a, b))
                                exempt_pairs.add((b, a))
                    if '母题' in col(r, '类型') and '逐字' in col(r, '回收方式'):
                        for ph in re.split(r'[；;、/|]', col(r, '内容')):
                            ph = norm(ph)
                            if len(ph) >= 3:
                                exempt_phrases.add(ph)
                print(f"  [E项豁免] 读入伏笔钩子台账：配对 {len(exempt_pairs)} 组、"
                      f"母题逐字短语 {len(exempt_phrases)} 条")
            except Exception as e:
                print(f"  [E项豁免] 读取 {tabs_path} 失败：{e}")
        for t, cs in tail_chaps.items():
            cs = sorted(cs)
            if len(cs) < 2:
                continue
            if any(t in w for w in wl):
                continue
            if any(t in ph or ph in t for ph in exempt_phrases):
                continue
            if all((a, b) in exempt_pairs for a, b in zip(cs, cs[1:])):
                continue
            tail_bad.append((t, cs))
        tail_bad.sort(key=lambda x: (-len(x[1]), x[0]))

    result = {'n_files': len(files), 'n_sentences': len(all_s),
              'exact_dups': dup_exact, 'sim_dups': sim_dups, 'struct_dups': dup_open,
              'ngram_dups': [{'tail': t, 'chapters': cs,
                              'ctx': [f'第{c}章：{s}' for c, s in tail_ctx[t]]}
                             for t, cs in tail_bad]}
    out = json.dumps(result, ensure_ascii=False, indent=1)
    if args.out:
        open(args.out, 'w', encoding='utf-8').write(out)
    print(f"文件数{len(files)} 句子数{len(all_s)} 白名单{len(wl)}条")
    print(f"\n== A. 精确重复句（≥{args.min_len}字）：{len(dup_exact)}组 ==")
    for d in dup_exact[:15]:
        print(f"  [{d['count']}次] {d['text'][:44]}  @ {','.join(d['where'][:3])}")
    # V0.40.8 门精简（作者 2026-09-10 批准）：B 高相似句对降级为报警，不阻断 exit code
    print(f"\n== B. 高相似句对（sim≥{args.sim}）：{len(sim_dups)}对"
          f"【报警（V0.40.8 降级，不再打回）】==")
    for d in sim_dups[:10]:
        print(f"  ({d['ratio']}) {d['a']}… ↔ {d['b']}…")
    print(f"\n== C. 同构复述（同句首key）：{len(dup_open)}组，其中打回{len(struct_bad)}组"
          f"（组内最高相似度≥{args.struct_sim}）==")
    for d in dup_open[:12]:
        flag = '打回' if d['violation'] else '观察'
        print(f"  [{flag} key:{d['key']} worst={d['worst_sim']}] {d['count']}句  "
              f"@ {','.join(d['where'][:3])}")
        for p in d['pairs'][:2]:
            print(f"     · {p['a']}… ↔ {p['b']}… (sim{p['ratio']})")
    if len(dup_open) > 12:
        print(f"  …（其余 {len(dup_open) - 12} 组见 --out JSON）")
    print(f"\n== E. 跨章句尾短语复用（叙述层句尾{TAIL_N}字跨章重复即打回）：{len(tail_bad)}组 =="
          + ('' if args.tail_reuse else '  [未启用：--tail-reuse 为待评审判据，默认关闭]'))
    for t, cs in tail_bad[:12]:
        print(f"  [句尾：{t}] 章号{cs}")
        for c, s in tail_ctx[t][:2]:
            print(f"     第{c}章：{s}…")

    print(f"\n== F. 跨章长短语复用（{PHRASE_N}字以上，N15 信息回调必须变奏）：{len(ph_bad)}组 =="
          + ('' if args.phrase_reuse else '  [未启用]'))
    for ph, cs in ph_bad[:12]:
        print(f"  [{ph}] 章号{cs}")
        for c, s in ph_ctx[ph][:2]:
            print(f"     第{c}章：{s}…")

    # V0.40.8 门精简（作者 2026-09-10 批准）：sim_dups（B 高相似句对）从 fails 移入 warns，
    # 报警不阻断 exit code；其余打回项判定不变。
    warns = []
    if sim_dups:
        warns.append(f"高相似句对{len(sim_dups)}对")
    fails = []
    if dup_exact:
        fails.append(f"精确重复{len(dup_exact)}组")
    if struct_bad:
        fails.append(f"同构复述{len(struct_bad)}组")
    if tail_bad:
        fails.append(f"跨章句尾短语复用{len(tail_bad)}组")
    if ph_bad:
        fails.append(f"跨章长短语复用{len(ph_bad)}组")
    if warns:
        print(f"\n== 报警（V0.40.8 降级，不阻断 exit code）：{'、'.join(warns)} ==")
    if fails:
        print(f"\n== 打回：{'、'.join(fails)} ==")
        sys.exit(2)
    print("\n重复与同构检查通过。")

if __name__ == '__main__':
    main()

