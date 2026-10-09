#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""N1 风格锚定卡生成器（作者裁定：AI 依大纲/设定自定锚点 + 每章自检）

流程（规则书第一节 N1 落地）：
  ① 开书时：AI 读 主题定位/卷纲 + 语域卡 + 分题材基线 → 产出本卡（一次）
  ② 每章生成前：本卡的目标带写进注入包（build_context.py 第四节已自动带）
  ③ 每章生成后：跑门7 `dist_check.py` 自检 → 偏差报警/打回
  ④ 人只需在开书时确认一次本卡

用法：
  python 03_评分与校准/style_anchor.py --genre "西幻/异世界" --book "骨语者" \
      --outline "15_新书_骨语者/00_设定与卷纲.md" --out "15_新书_骨语者/12_风格锚点卡.md"
"""
import argparse
import io
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
CB = os.path.join(ROOT, '08_统计基线', '题材基线_章级_133本.json')
PB = os.path.join(ROOT, '08_统计基线', 'ppl_分题材_133本.json')
GB = os.path.join(ROOT, '08_统计基线', '题材基线_133本.json')

SPEC = [('smean', '均句长', 'low'), ('ssd', '句长sd', 'low'),
        ('pmean', '均段长', 'high'), ('psd', '段长sd', 'high'),
        ('dlg_pct', '对白段%', 'low'), ('env2_pct', '环境段%严格', 'high'),
        ('said_kilo', '说族/千字', 'high'), ('simile_kilo', '明喻/千字', 'high'),
        ('conn_nat_kilo', '承接词自然/千字', 'low'), ('conn_kilo', '承接词AI/千字', 'high'),
        ('head_rep', '句首重复率', 'high'), ('pol_sd', '情感极性sd', 'low'),
        ('pol_turns_kilo', '情感转折/千字', 'lowp25'),
        ('pol_pos_pct', '正向句%', 'low'), ('pol_neg_pct', '负向句%', 'low')]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--genre', default='西幻/异世界')
    ap.add_argument('--book', required=True)
    ap.add_argument('--outline', default=None, help='设定与卷纲（可选，写进卡里做锚定依据）')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    cb = json.load(io.open(CB, encoding='utf-8'))
    g = (cb.get('genres') or {}).get(args.genre) or cb['all']
    pb = json.load(io.open(PB, encoding='utf-8'))
    pg = (pb.get('genres') or {}).get(args.genre) or pb.get('all')
    gb = json.load(io.open(GB, encoding='utf-8'))
    gg = (gb.get('genres') or {}).get(args.genre) or gb.get('all')

    lines = ['# 风格锚点卡 · 《%s》' % args.book, '',
             '> **N1 风格锚定落地件**（作者裁定：AI 依大纲/设定自定锚点 + 每章自检）。',
             '> 锚点来源：%s 档真人章级实测（n=%s，每样本 3000 字）＋困惑度分档基线。' % (
                 args.genre, g.get('n')),
             '> 用途：①开书确认一次 ②每章写进注入包 ③每章写后跑门7 自检。',
             '> **本卡只给区间，不给点值**——真人单章波动极大（见 min~max）。', '']
    if args.outline and os.path.exists(args.outline):
        txt = io.open(args.outline, encoding='utf-8').read()
        head = [l for l in txt.split('\n') if l.strip().startswith('#')][:8]
        lines += ['## 一、锚定依据（来自本书设定）', '']
        lines += ['- ' + h.lstrip('# ').strip() for h in head]
        lines += ['', '> 由大纲决定的是**题材档与语域**；由真人基线决定的是**可测区间**。', '']
    lines += ['## 二、叙述层可测锚点（每章必须落带）', '',
              '| 指标 | 目标带（p25~p75） | 硬底线 | 方向 |', '|---|---|---|---|']
    arrow = {'low': '越高越像人（下限）', 'high': '越低越安全（上限）',
             'lowp25': '低于 p25 报警'}
    for k, lab, d in SPEC:
        v = g.get(k)
        if not v:
            continue
        if d == 'low':
            hard = '≥ %s' % v['min']
        elif d == 'high':
            hard = '≤ %s' % v['max']
        else:
            hard = '≥ %s（p25）' % v['p25']
        lines.append('| %s | %s ~ %s | **%s** | %s |' % (
            lab, v['p25'], v['p75'], hard, arrow[d]))
    lines += ['', '## 三、困惑度锚点', '',
              '| 指标 | 目标 | 依据 |', '|---|---|---|',
              '| 困惑度 | ≥ **%s** | %s 档 p10 |' % (
                  pg['perplexity']['p10'], args.genre),
              '| nll_std | ≥ **%s** | %s 档 p10 |' % (pg['nll_std']['p10'], args.genre),
              '| 章间趋势 | **禁止连续下降** | 单调下降＝越写越可预测（机器指纹） |', '']
    lines += ['## 四、语域红线（不可越）', '',
              '- 叙述层：中文白话，**不欧化**、不文言化；方言只在角色籍贯明确时进对话。',
              '- 对话层：可带人物语癖（门14 对表）；称呼/口头禅/禁用词以设定表为准。',
              '- 术语密度：门3 上限 12/千字；术语表必配。', '',
              '## 五、每章自检命令', '',
              '```powershell',
              'python 03_评分与校准/dist_check.py --chapters "%s/chapters/*.md" --genre "%s"' % (
                  os.path.dirname(args.out).replace('\\', '/'), args.genre),
              '```', '',
              '> 判定：档内 → 通过；越 min/max → 报警；**同一指标连续 3 章越界 → 打回**；',
              '> ≥10 章时中位数须落 p25~p75。豁免（高潮章/设定推进章/母题回调）走 `--exempt`。', '']
    io.open(args.out, 'w', encoding='utf-8').write('\n'.join(lines))
    print('已生成 %s（%d 行）' % (args.out, len(lines)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
