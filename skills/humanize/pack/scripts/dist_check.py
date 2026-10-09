#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""门7 · 分布对齐（dist_check.py）

七维度攻坚新增门族。前六族管"别太多"（上限），本族管**上下限双向**：
真人分布是区间，我们的稿长期落在区间的下缘（句长/句长波动/情感波动）和上缘
（环境段/段长极端值）。**只压上限同样会脱离人类分布**——这是本轮最大的发现。

判据（D1~D17，全部逐章；分题材档取阈值）
  D1  均句长           下限   西幻章级 min 17.14
  D2  句长sd           下限   西幻章级 min 9.56
  D3  均段长           上限   西幻章级 max 46.39
  D4  段长sd           上限   西幻章级 max 31.17
  D5  环境段%严格       上限   西幻章级 max 20.5
  D6  对白段%           下限   西幻章级 min 2.0
  D7  说族/千字         上限   西幻章级 max 24.09（与门3 占比门并行，不替代）
  D8  明喻/千字         上限   西幻章级 max 6.38
  D9  承接词(自然)/千字  下限   西幻章级 min 0.71（M2 词表）
  D10 承接词(AI)/千字    上限   西幻章级 max 3.52（防 AI 腔复发）
  D11 句首重复率         上限   西幻章级 max 0.204（M5）
  D12 情感极性sd         下限   西幻章级 min 0.451（M4）
  D13 情感转折/千字      下限   西幻章级 p25 0.72（min=0 无判别力，故取 p25）
  D14 正向句%           下限   西幻章级 min 3.7
  D15 负向句%           下限   西幻章级 min 4.0
  D16 困惑度             下限   西幻 p10 17.68（需 --ppl-json，默认 SKIP）
  D17 章间漂移           连续 3 章同指标单向变化 ≥15% → 报警

判定分级（门设计原则 P1~P6）
  · 落在 min~max 内        → 通过
  · 落在 p25~p75 之外但档内 → 记录（提示，不报警）
  · 越 min/max            → 报警；**同一指标连续 3 章同向越界 → 打回**
  · 章数 ≥10 时，中位数未落 p25~p75 → 打回（卷级分布级判定 P3）
  · --exempt 豁免白名单（高潮章/设定推进章/母题回调）优先于一切

⚠️ 已证伪、本门**不设**的判据：
  · 杂讯下限（原 G7）——零杂讯是**长度假象**：真人 3000 字窗口 57% 零杂讯、
    2 万字 23%、20 万字才 2%。逐章要求杂讯必然误伤，故废弃。
  · 段长双峰鞍部——真人 60/133 也有。

用法：
  python 03_评分与校准/dist_check.py --chapters "15_新书_骨语者/chapters/*.md" --genre "西幻/异世界"
  python 03_评分与校准/dist_check.py --chapters "chapters/*.md" --ppl-json "10b_困惑度.json"
退出码：0 通过 / 2 打回 / 3 缺基线

V0.41（输出收敛，见 17_修复方案/03_门判据精简提案.md 第六节）：
  --quiet：只打印越界/报警项＋豁免命中明细＋一行结果；不打印 15 行指标表与档内偏边记录。
  --quiet 只影响"打印什么"，不影响"判什么"（阈值/打回/退出码不变）。
  run_gates.py 在收敛模式下调用本脚本时会自动追加 --quiet。
"""
import argparse
import glob
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _metrics import probe, read_text  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
# 2026-09-11：兼容两种布局——主工程用 08_统计基线/，技能包用 data/。
# 此前技能包内门7 因找不到基线直接 exit 3（异常，非判定），回归 3 项必失败。
_BASELINE_DIRS = [os.path.join(ROOT, '08_统计基线'), os.path.join(ROOT, 'data')]


def _first_existing(name):
    for d in _BASELINE_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return os.path.join(_BASELINE_DIRS[0], name)


DEFAULT_BASELINE = _first_existing('题材基线_章级_133本.json')
DEFAULT_PPL_BASELINE = _first_existing('ppl_分题材_133本.json')

# (key, 中文名, 方向, 小数位)  方向: low=越下限报警 / high=越上限报警 / lowp25=低于p25报警
SPEC = [
    ('smean', '均句长', 'low', 1),
    ('ssd', '句长sd', 'low', 1),
    ('pmean', '均段长', 'high', 1),
    ('psd', '段长sd', 'high', 1),
    ('env2_pct', '环境段%严格', 'high', 1),
    ('dlg_pct', '对白段%', 'low', 1),
    ('said_kilo', '说族/千字', 'high', 2),
    ('simile_kilo', '明喻/千字', 'high', 2),
    ('conn_nat_kilo', '承接词自然/千字', 'low', 2),
    ('conn_kilo', '承接词AI/千字', 'high', 2),
    ('head_rep', '句首重复率', 'high', 3),
    ('pol_sd', '情感极性sd', 'low', 3),
    ('pol_turns_kilo', '情感转折/千字', 'lowp25', 2),
    ('pol_pos_pct', '正向句%', 'low', 1),
    ('pol_neg_pct', '负向句%', 'low', 1),
]
# 漂移检测用（方向无关，只看单调性）
DRIFT_KEYS = [('smean', '均句长'), ('pmean', '均段长'), ('dlg_pct', '对白段%'),
              ('env2_pct', '环境段%严格'), ('said_kilo', '说族/千字'),
              ('pol_sd', '情感极性sd')]


def load_json(p, default=None):
    if p and os.path.exists(p):
        try:
            return json.load(io.open(p, encoding='utf-8'))
        except Exception:
            return default
    return default


def band_of(base, genre):
    """取题材档；样本不足则退回全库档。"""
    g = (base.get('genres') or {}).get(genre)
    if g and g.get('n', 0) >= 12:
        return g, 'genre:%s(n=%d)' % (genre, g['n'])
    return base['all'], 'all(n=%d)' % base['all']['n']


# V0.39（作者指示"所有上限都可以调高 10%-20%"）：上限型判据统一放宽 15%
UPPER_SLACK = 1.15


def verdict(key, direction, val, b):
    """返回 ('ok'|'note'|'warn', 说明)"""
    lo, hi = b.get('min'), b.get('max')
    p25, p75 = b.get('p25'), b.get('p75')
    if direction == 'low':
        if val < lo:
            return 'warn', '低于下限 %.3f' % lo
        if val < p25:
            return 'note', '低于 p25 %.3f（档内但偏下）' % p25
        return 'ok', ''
    if direction == 'high':
        if hi is not None:
            hi = hi * UPPER_SLACK
        if p75 is not None:
            p75 = p75 * UPPER_SLACK
        if val > hi:
            return 'warn', '超上限 %.3f' % hi
        if val > p75:
            return 'note', '超 p75 %.3f（档内但偏上）' % p75
        return 'ok', ''
    if direction == 'lowp25':
        if val < p25:
            return 'warn', '低于 p25 %.3f（该指标 min 无判别力，取 p25 为报警线）' % p25
        return 'ok', ''
    return 'ok', ''


LABEL_OF = {k: lab for k, lab, _, _ in SPEC}


def is_exempt(ex_set, key):
    """豁免白名单可写指标键（smean）或中文名（均句长）。"""
    return key in ex_set or LABEL_OF.get(key, key) in ex_set


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True, help='章节文件（通配，可分号分隔）')
    ap.add_argument('--genre', default='西幻/异世界', help='题材档')
    ap.add_argument('--baseline', default=DEFAULT_BASELINE, help='章级基线 JSON')
    ap.add_argument('--ppl-json', default=None, help='困惑度实测 JSON（style_metrics --out 产物）')
    ap.add_argument('--ppl-baseline', default=DEFAULT_PPL_BASELINE)
    ap.add_argument('--exempt', default=None, help='豁免白名单 JSON')
    ap.add_argument('--json', default=None, help='结果 JSON 输出')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    base = load_json(args.baseline)
    if not base:
        print('缺基线文件 %s（先跑 build_chapter_baseline.py）' % args.baseline, file=sys.stderr)
        return 3
    band, band_label = band_of(base, args.genre)
    exempt = load_json(args.exempt, {}) or {}

    targets = []
    for p in args.chapters.split(';'):
        targets += sorted(glob.glob(p))
    if not targets:
        print('no chapters', file=sys.stderr)
        return 3

    rows = []
    for f in targets:
        name = os.path.basename(f)
        r = probe(read_text(f), name)
        rows.append(r)

    # 困惑度
    ppl_rows = {}
    if args.ppl_json:
        pj = load_json(args.ppl_json, {}) or {}
        for it in (pj.get('rows') or pj.get('items') or []):
            ppl_rows[os.path.basename(str(it.get('label', it.get('name', ''))))] = it
        pb = load_json(args.ppl_baseline, {}) or {}
        pg = ((pb.get('genres') or {}).get(args.genre) or {})

    warns = []      # (章, 指标, 说明)
    notes = []
    exempted = []
    for r in rows:
        name = r['name']
        ex = set(exempt.get(name) or [])
        for key, lab, direction, nd in SPEC:
            if is_exempt(ex, key):
                exempted.append((name, lab, '章级豁免'))
                continue
            st, why = verdict(key, direction, r[key], band.get(key, {}))
            if st == 'warn':
                warns.append((name, lab, why, key))
            elif st == 'note':
                notes.append((name, lab, why, key))

    # 连续 3 章同向越界 → 打回
    hard = []
    for key, lab, direction, nd in SPEC:
        streak = 0
        run = []
        for r in rows:
            if is_exempt(set(exempt.get(r['name']) or []), key):
                streak, run = 0, []
                continue
            st, why = verdict(key, direction, r[key], band.get(key, {}))
            if st == 'warn':
                streak += 1
                run.append(r['name'])
            else:
                streak, run = 0, []
            if streak == 3:
                hard.append((lab, '连续 3 章越界：%s' % '、'.join(x[:10] for x in run)))
                break

    # 章间漂移（连续 3 章单向 ≥15%）
    drift = []
    for key, lab in DRIFT_KEYS:
        vals = [r[key] for r in rows]
        for i in range(len(vals) - 2):
            a, b, c = vals[i], vals[i + 1], vals[i + 2]
            if a <= 0 or b <= 0 or c <= 0:
                continue
            if (b - a) / a >= 0.15 and (c - b) / b >= 0.15:
                drift.append((lab, '单调上升：%s → %s → %s' % (
                    '%.2f' % a, '%.2f' % b, '%.2f' % c)))
                break
            if (a - b) / a >= 0.15 and (b - c) / b >= 0.15:
                drift.append((lab, '单调下降：%s → %s → %s' % (
                    '%.2f' % a, '%.2f' % b, '%.2f' % c)))
                break

    # 卷级：≥10 章时中位数需落 p25~p75
    dist_hard = []
    if len(rows) >= 10:
        for key, lab, direction, nd in SPEC:
            v = sorted(r[key] for r in rows)
            med = v[len(v) // 2]
            b = band.get(key, {})
            if not b:
                continue
            if med < b['p25'] or med > b['p75']:
                dist_hard.append((lab, '中位数 %.3f 未落 p25~p75（%.3f~%.3f）' % (
                    med, b['p25'], b['p75'])))

    # 困惑度判定
    ppl_warn = []
    if args.ppl_json:
        for r in rows:
            it = ppl_rows.get(r['name'])
            if not it:
                continue
            pg = ((load_json(args.ppl_baseline, {}) or {}).get('genres') or {}).get(args.genre, {})
            if pg:
                if it.get('perplexity', 0) < pg['perplexity']['p10']:
                    ppl_warn.append((r['name'], '困惑度 %.2f < 西幻 p10 %.2f' % (
                        it['perplexity'], pg['perplexity']['p10'])))
                if it.get('nll_std', 0) < pg['nll_std']['p10']:
                    ppl_warn.append((r['name'], 'nll_std %.3f < 西幻 p10 %.3f' % (
                        it['nll_std'], pg['nll_std']['p10'])))

    # ── 输出 ──
    if not args.quiet:
        print('=' * 78)
        print('门7 · 分布对齐（%d 章｜档位 %s）' % (len(rows), band_label))
        print('=' * 78)
        print('%-14s %8s %8s %8s %8s %8s  判定' % ('指标', 'min', 'p25', 'med', 'p75', 'max'))
        for key, lab, direction, nd in SPEC:
            b = band.get(key, {})
            if not b:
                continue
            f = '{:.%df}' % nd
            sts = []
            for r in rows:
                st, _ = verdict(key, direction, r[key], b)
                sts.append({'ok': '·', 'note': 'o', 'warn': 'X'}[st])
            vals = ' '.join('%-6.6s' % f.format(r[key]) for r in rows)
            print('%-14s %8s %8s %8s %8s %8s  %s' % (
                lab, f.format(b['min']), f.format(b['p25']), f.format(b['med']),
                f.format(b['p75']), f.format(b['max']), ''.join(sts)))
            print('%-14s %s' % ('', vals + '   (每章实测)'))
        print('\n图例：· 通过  o 档内偏边（记录）  X 越界（报警）')

    if notes and not args.quiet:
        print('\n[记录] 档内偏边 %d 处（不报警，供恶人编辑参考）' % len(notes))
        for n, lab, why, _ in notes[:12]:
            print('  · %s %s：%s' % (n[:14], lab, why))
    if exempted:
        if args.quiet:
            # V0.41 输出收敛：豁免命中属于"必须看的项"，quiet 下也完整打印明细
            print('\n[豁免] %d 处（白名单）：' % len(exempted))
            for n, lab, why in exempted:
                print('  · %s %s：%s' % (n[:14], lab, why))
        else:
            print('\n[豁免] %d 处（白名单）' % len(exempted))
    if warns:
        print('\n[报警] 越界 %d 处：' % len(warns))
        for n, lab, why, _ in warns:
            print('  ⚠ %s %s：%s' % (n[:14], lab, why))
    if drift:
        print('\n[报警] 章间漂移 %d 处：' % len(drift))
        for lab, why in drift:
            print('  ⚠ %s %s' % (lab, why))
    if ppl_warn:
        print('\n[报警] 困惑度 %d 处：' % len(ppl_warn))
        for n, why in ppl_warn:
            print('  ⚠ %s %s' % (n[:14], why))
    elif args.ppl_json:
        print('\n[困惑度] 全部达标')

    failed = bool(hard or dist_hard)
    if hard:
        print('\n[打回] 连续 3 章越界：')
        for lab, why in hard:
            print('  ✗ %s %s' % (lab, why))
    if dist_hard:
        print('\n[打回] 卷级分布不达标（≥10 章）：')
        for lab, why in dist_hard:
            print('  ✗ %s %s' % (lab, why))
    if not failed:
        print('\n门7 结果：通过（报警 %d 处%s）' % (
            len(warns), '，未触发连续 3 章打回' if warns else ''))

    if args.json:
        out = {'genre': args.genre, 'band': band_label, 'n_chapters': len(rows),
               'chapters': [{'name': r['name'], 'chars': r['chars'],
                             **{k: round(r[k], 4) for k, _, _, _ in SPEC}} for r in rows],
               'warn': [{'chapter': n, 'metric': lab, 'why': w} for n, lab, w, _ in warns],
               'note': [{'chapter': n, 'metric': lab, 'why': w} for n, lab, w, _ in notes],
               'hard': [{'metric': l, 'why': w} for l, w in hard + dist_hard],
               'drift': [{'metric': l, 'why': w} for l, w in drift],
               'ppl_warn': [{'chapter': n, 'why': w} for n, w in ppl_warn]}
        io.open(args.json, 'w', encoding='utf-8').write(
            json.dumps(out, ensure_ascii=False, indent=1))
        print('→ %s' % args.json)

    return 2 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
