# -*- coding: utf-8 -*-
"""narrative_probe.py — 叙事层探针（测量工具，**不是门**）

## 为什么是"探针"而不是"门"

作者裁定：新增门/判据必须经评审 + 过回归测试。本文件**只测量、不打回、不计 exit code**，
用途是把"感觉像 AI"变成可对照的数字，为提案提供依据（先测后立）。

## 测什么（对齐朱雀七维度的可脚本化部分）

| 探针 | 对应朱雀维度 | 说明 |
|---|---|---|
| 段长分布直方图 + 中段塌陷 | 维度二 爆发性 | 是否有"双峰鞍部"（中段 bin 塌陷） |
| 句长 mean/sd、句首重复率 | 维度二 爆发性 | 句长均匀度、句首结构单一 |
| 引述动词分布 | 维度七 风格匹配 | 说族占比（门6 已有，此处按章细看） |
| 环境段占比 | （我们自己的缺口） | 不含引号且含环境词的段落比例 |
| 对白段占比 | 维度七 | 含引号段落比例 |
| 修辞标记密度 | 维度四 修辞多样性 | 像/仿佛/如同/似的/宛如 |
| 因果承接词密度 | 维度三 语义连贯性 | 因此/所以/然而/于是/另一方面… |
| 杂讯统计 | 零杂讯问题 | 半角标点、连续标点、非常规标点 |

用法：
  python narrative_probe.py --files "chapters/*.md"
  python narrative_probe.py --corpus "04_语料/真人语料_网文57本" --sample 8
"""
import argparse
import glob
import io
import json
import os
import re
import statistics as st
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ── 指标计算统一走 _metrics.py（V0.38 抽取，保证探针/门7/注入包口径一致）──
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _metrics import (  # noqa: E402
    probe, saddle, probe_file, read_text, BINS, BIN_LABELS, CONNECT_AI, CONNECT_NAT,
    CONNECT_FN, ENV_WORDS, SAID_WORDS, SIMILE, NOISE_PAT, split_paras, split_sents,
    norm_len,
)


def show(r):
    print(f"\n--- {r['name']} ---")
    print(f"  {r['chars']} 字 / {r['paras']} 段 / 均段长 {r['pmean']:.1f} / 段长sd {r['psd']:.1f}"
          f" | {r['sents']} 句 / 均句长 {r['smean']:.1f} / 句长sd {r['ssd']:.1f}")
    print(f"  对白段 {r['dlg_pct']:.0f}% / 环境段 {r['env_pct']:.0f}%（严格 {r['env2_pct']:.0f}%）"
          f" / 环境句 {r['envsent_pct']:.0f}% / 句首重复率 {r['head_rep']*100:.0f}%"
          f"（Top: {r['head_top']}）")
    print(f"  说族 {r['said_kilo']:.1f}/千字 / 明喻 {r['simile_kilo']:.1f}/千字"
          f" / 因果承接词 {r['conn_kilo']:.1f}/千字")
    print(f"  杂讯: " + '，'.join(f'{k}={v}' for k, v in r['noise'].items()))
    tot = sum(r['hist']) or 1
    print("  段长分布: " + ' '.join(
        f"{BIN_LABELS[i]}={r['hist'][i]}({100.0*r['hist'][i]/tot:.0f}%)"
        for i in range(len(r['hist']))))
    s = saddle(r['hist'])
    if s and s['saddle']:
        i, d = s['saddle']
        print(f"  ⚠ 双峰鞍部: 第{i}档({BIN_LABELS[i]})低于两侧，落差 {d}")
    elif s:
        print("  无鞍部（单峰或单调）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', default=None, help='章节文件（可用通配）')
    ap.add_argument('--corpus', default=None, help='语料目录（真人基线）')
    ap.add_argument('--sample', type=int, default=6, help='语料抽样本数（0=全部）')
    ap.add_argument('--sample-chars', type=int, default=200000,
                    help='每本取多少字（默认 20 万；门7 阈值用 3000 字匹配长度基线）')
    ap.add_argument('--verbose', action='store_true', help='逐本打印语料明细')
    ap.add_argument('--genres', default=None,
                    help='题材标签 JSON（如 08_统计基线/语域指纹_57本.json）→ 输出分题材基线')
    ap.add_argument('--json', default=None,
                    help='把分题材基线写成 JSON（供 build_context.py 读取）')
    args = ap.parse_args()

    targets = []
    if args.files:
        for p in args.files.split(';'):
            targets += sorted(glob.glob(p))
    if not targets:
        print('no files', file=sys.stderr)
        return 1

    print('=' * 72)
    print('叙事层探针（测量工具，不是门）')
    print('=' * 72)
    for f in targets:
        show(probe(io.open(f, encoding='utf-8').read(), os.path.basename(f)))

    if args.corpus and os.path.isdir(args.corpus):
        books = sorted(glob.glob(os.path.join(args.corpus, '*.txt')))
        if args.sample:
            books = books[:args.sample]
        if books:
            print('\n' + '=' * 72)
            print(f'真人语料基线（{len(books)} 本，每本取前 {args.sample_chars//10000 if args.sample_chars>=10000 else args.sample_chars} {chr(0x4e07) if args.sample_chars>=10000 else chr(0x5b57)}）')
            print('=' * 72)
            agg = []
            cache = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 '..', '08_统计基线', '_cache')
            for b in books:
                r = probe_file(b, sample_chars=args.sample_chars, cache_dir=cache)
                agg.append(r)
                if args.verbose:
                    print(f"  {r['name'][:22]:<24} {r['chars']:>7}字 {r['paras']:>5}段 "
                          f"均段长{r['pmean']:>5.1f} 段sd{r['psd']:>5.1f} "
                          f"均句长{r['smean']:>5.1f} 句sd{r['ssd']:>5.1f} "
                          f"对白{r['dlg_pct']:>3.0f}% 说{r['said_kilo']:>4.1f} "
                          f"喻{r['simile_kilo']:>4.1f} 连{r['conn_kilo']:>4.1f}")
            if agg:
                def pct(vals, p):
                    vals = sorted(vals)
                    i = min(len(vals) - 1, max(0, int(round((len(vals) - 1) * p))))
                    return vals[i]

                def line(key, label, fmt='{:.1f}'):
                    v = [a[key] for a in agg]
                    print(f"  {label:<14} min {fmt.format(min(v)):>7}  p25 {fmt.format(pct(v,.25)):>7}"
                          f"  med {fmt.format(pct(v,.5)):>7}  p75 {fmt.format(pct(v,.75)):>7}"
                          f"  max {fmt.format(max(v)):>7}")

                print('\n  分布（真人 n=%d）' % len(agg))
                line('pmean', '均段长')
                line('psd', '段长sd')
                line('smean', '均句长')
                line('ssd', '句长sd')
                line('dlg_pct', '对白段%')
                line('env_pct', '环境段%')
                line('env2_pct', '环境段%严格')
                line('envsent_pct', '环境句%')
                line('said_kilo', '说族/千字')
                line('simile_kilo', '明喻/千字')
                line('conn_kilo', '承接词(AI表)/千')
                line('conn_nat_kilo', '承接词(自然)/千')
                line('conn_fn_kilo', '单字虚词/千字')
                line('head_rep', '句首重复率', '{:.3f}')
                line('pol_sd', '情感极性sd', '{:.3f}')
                line('pol_turns_kilo', '情感转折/千字', '{:.2f}')
                line('pol_pos_pct', '正向句%')
                line('pol_neg_pct', '负向句%')
                noise_tot = {k: sum(a['noise'][k] for a in agg) for k in agg[0]['noise']}
                chars_tot = sum(a['chars'] for a in agg)
                print(f"\n  杂讯合计（{chars_tot} 字）: " + '，'.join(
                    f'{k}={v}（{1000.0*v/chars_tot:.2f}/千字）' for k, v in noise_tot.items()))
                zero_noise = sum(1 for a in agg if sum(a['noise'].values()) == 0)
                print(f"  零杂讯本数: {zero_noise}/{len(agg)}")
                sad = sum(1 for a in agg if (saddle(a['hist']) or {}).get('saddle'))
                print(f"  存在段长鞍部的本数: {sad}/{len(agg)}")

                # ── 分题材基线 ──
                if args.genres and os.path.exists(args.genres):
                    gmap = {}
                    for item in json.load(io.open(args.genres, encoding='utf-8')):
                        gmap[os.path.basename(item.get('book', ''))] = item.get('genre', '未标')
                    groups = {}
                    for a in agg:
                        groups.setdefault(gmap.get(a['name'], '未标'), []).append(a)
                    print('\n' + '=' * 72)
                    print('分题材基线（仅列出样本 n≥3 的题材；p25/med/p75）')
                    print('=' * 72)
                    keys = [('smean', '均句长'), ('ssd', '句长sd'), ('pmean', '均段长'),
                            ('psd', '段长sd'), ('dlg_pct', '对白段%'),
                            ('env2_pct', '环境段%严格'), ('said_kilo', '说族/千字'),
                            ('simile_kilo', '明喻/千字'), ('conn_kilo', '承接词AI/千字'),
                            ('conn_nat_kilo', '承接词自然/千字'), ('conn_fn_kilo', '单字虚词/千字'),
                            ('head_rep', '句首重复率'), ('pol_sd', '情感极性sd'),
                            ('pol_turns_kilo', '情感转折/千字'), ('pol_pos_pct', '正向句%'),
                            ('pol_neg_pct', '负向句%')]
                    for g, items in sorted(groups.items(), key=lambda x: -len(x[1])):
                        if len(items) < 3:
                            continue
                        print(f"\n  【{g}】n={len(items)}")
                        for k, lab in keys:
                            v = [x[k] for x in items]
                            print(f"    {lab:<12} min {min(v):>7.1f}  p25 {pct(v,.25):>7.1f}"
                                  f"  med {pct(v,.5):>7.1f}  p75 {pct(v,.75):>7.1f}  max {max(v):>7.1f}")
                        ct = sum(x['chars'] for x in items)
                        nz = {k: sum(x['noise'][k] for x in items) for k in items[0]['noise']}
                        print(f"    杂讯/千字    " + ' '.join(
                            f'{k}={1000.0*v/ct:.2f}' for k, v in nz.items()))
                    # 写 JSON（供注入包/门读取）
                    if args.json:
                        dump = {'corpus': args.corpus, 'n_books': len(agg),
                                'metrics': [k for k, _ in keys], 'genres': {}}
                        for g, items in groups.items():
                            if len(items) < 3:
                                continue
                            d = {'n': len(items)}
                            for k, lab in keys:
                                v = [x[k] for x in items]
                                d[k] = {'min': round(min(v), 2), 'p25': round(pct(v, .25), 2),
                                        'med': round(pct(v, .5), 2), 'p75': round(pct(v, .75), 2),
                                        'max': round(max(v), 2)}
                            ct = sum(x['chars'] for x in items)
                            d['noise_per1k'] = round(
                                sum(sum(x['noise'].values()) for x in items) / max(ct, 1) * 1000, 3)
                            dump['genres'][g] = d
                        allv = {k: [x[k] for x in agg] for k, _ in keys}
                        dump['all'] = {'n': len(agg)}
                        for k, _ in keys:
                            v = allv[k]
                            dump['all'][k] = {'min': round(min(v), 2), 'p25': round(pct(v, .25), 2),
                                              'med': round(pct(v, .5), 2), 'p75': round(pct(v, .75), 2),
                                              'max': round(max(v), 2)}
                        json.dump(dump, io.open(args.json, 'w', encoding='utf-8'),
                                  ensure_ascii=False, indent=1)
                        print(f'\n已写 {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
