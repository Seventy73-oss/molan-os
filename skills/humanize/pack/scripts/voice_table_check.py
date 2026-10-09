# -*- coding: utf-8 -*-
"""voice_table_check.py — 门14 语癖卡对表（规则书 V0.36）

## 规则（作者裁定）

> "人设台词的一致性一定要对表！"

**一律以「主角/配角设定表」的语癖卡六列为准**：口头禅 / 句长偏好 / 标点习惯 / 损法 / 称呼习惯 / 禁用方式。
**只查"该角色有没有违反自己在设定表里登记的卡"**——不做通用语域模型判声音（那种已被证伪为太死板）。

## 判据

【打回】禁用方式：设定表里用 `禁用：词1;词2` 形式登记的**字面禁用词**出现在该角色对白里
【报警】称呼习惯：`称X为「Y」` 形式的登记，若该角色对白里对 X 用了别的称呼
【报警】口头禅：登记了口头禅且该角色本章说话 ≥3 次，但口头禅一次都没出现
【报警】句长偏好：登记"短句"却对白均长 > 25 字；登记"长句"却 < 12 字

> V0.40.8 门精简（作者 2026-09-10 批准）：语癖卡报警**仅限字面登记**触发——
> "行话不离口/记账式/敬语反讽"这类**描述性登记**（风格描述，不是会逐字出现在
> 对白里的原词）不再逐条输出"跳过项"、不再触发口头禅假报警，改为**汇总一行**
> 提示改表格式（README 3.1：口头禅只填字面原词；禁用方式写 `禁用：词1;词2`）。
> 禁用词字面命中仍是打回（不变）。

用法：
  python voice_table_check.py --chapters "chapters" --tables "设定表_书名.xlsx"
"""
import argparse
import glob
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from _tables import col, find_tables, load_tables, rows_of  # noqa: E402

QUOTE_RE = re.compile(r'[“「]([^”」]{1,300})[”」]')

# V0.40.8 门精简（作者 2026-09-10 批准）：口头禅"描述性风格标签"特征——
# 命中即为非字面登记（不核对、不报警、并入汇总行）。参考骨语者历史登记
# （行话不离口/记账式/敬语反讽/只闻其声）与 README 3.1 反例"行话不离口"。
_PET_STYLE_HINTS = ('不离口', '挂嘴边', '反讽', '只闻', '惜字如金',
                    '滔滔不绝', '腔', '口吻', '语气', '式')
_PET_QUOTE = re.compile(r'[“”「」『』‘’\'"]')
_PET_ANNOT = re.compile(r'[（(][^）)]*[）)]')


def _strip_annot(t):
    """去引号与括注：『说吧。』（听骨前）→ 说吧。；无（嘶鸣）→ 无"""
    t = _PET_QUOTE.sub('', t or '')
    t = _PET_ANNOT.sub('', t)
    return t.strip()


def pet_is_literal(ct):
    """口头禅登记是否字面原词（可逐字核对）。非字面 = 描述性风格标签。"""
    core = _strip_annot(ct)
    if not core or core in ('无', '—', '-'):
        return False                 # 无口头禅标记，不构成登记
    if any(ch in core for ch in '。！？…，、；：'):
        return True                  # 含对白句读 = 台词形态（字面）
    if any(h in core for h in _PET_STYLE_HINTS):
        return False                 # 风格标签：X式 / X不离口 / X反讽 …
    return True                      # 无句读短原词从宽按字面（宁漏不误伤）


def norm_name(s):
    return re.sub(r'[《》\s：:！!？?，,。·\-—~…]', '', s or '')


def split_list(s):
    return [x.strip() for x in re.split(r'[；;、，,/|]', s or '') if x.strip()]


def parse_banned(text):
    """从禁用方式里取字面禁用词：`禁用：A;B` → ['A','B']；无标记返回 []"""
    m = re.search(r'禁用\s*[:：]\s*(.+)', text or '')
    if not m:
        return []
    return split_list(m.group(1))


def parse_address(text):
    """从称呼习惯里取 (对象, 称呼)：`称凯尔「小子」` → ('凯尔','小子')"""
    out = []
    for m in re.finditer(r'称([\u4e00-\u9fff·]{2,6})\s*[「“"]([^」”"]{1,8})[」”"]', text or ''):
        out.append((m.group(1), m.group(2)))
    return out


def load_cards(tabs):
    """→ {角色名: {口头禅, 句长, 称呼, 禁用[], 卡来源}}"""
    cards = {}
    for sheet in ('主角设定表', '配角设定表'):
        for r in rows_of(tabs, sheet):
            name = col(r, '姓名')
            if not name:
                continue
            alias = split_list(col(r, '别名', '别名/外号'))
            c = {
                '口头禅': col(r, '口头禅'),
                '句长': col(r, '句长偏好'),
                '称呼': parse_address(col(r, '称呼习惯')),
                '禁用': parse_banned(col(r, '禁用方式', '禁用方式（绝不这么说）')),
                '禁用原文': col(r, '禁用方式', '禁用方式（绝不这么说）'),
                '别名': alias,
            }
            for n in [name] + alias:
                cards[n] = c
    return cards


def dialogues(text, names):
    """返回 [(角色名, 对白内容)]；说话人无法判定则跳过"""
    out = []
    for m in QUOTE_RE.finditer(text):
        seg = m.group(1).strip()
        if len(seg) < 2:
            continue
        pre = text[max(0, m.start() - 24):m.start()]
        post = text[m.end():m.end() + 30]
        cands = []
        for n in names:
            if n in pre:
                cands.append((pre.rfind(n), n))
        if not cands:
            for n in names:
                if n in post:
                    cands.append((post.find(n), n))
        if not cands:
            continue
        cands.sort()
        out.append((cands[-1][1], seg))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True)
    ap.add_argument('--tables', default=None)
    ap.add_argument('--short-max', type=float, default=25.0, dest='short_max')
    ap.add_argument('--long-min', type=float, default=12.0, dest='long_min')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.chapters, '*.md')))
    if not files:
        print('no chapters', file=sys.stderr)
        return 1
    tp = args.tables
    if not tp:
        cands = find_tables(args.chapters)
        tp = cands[0] if cands else None
    print('=' * 72)
    print(f'门14 语癖卡对表 | {len(files)} 章 | 设定表：{tp or "未找到"}')
    print('=' * 72)
    if not tp or not os.path.exists(tp):
        print('\n== 打回 ==\n  [C0 缺数据件] 未找到设定表工作簿。\n\n门14 打回。')
        return 2

    tabs = load_tables(tp)
    cards = load_cards(tabs)
    if not cards:
        print('\n== 打回 ==\n  [C0 缺卡] 主角/配角设定表里没有语癖卡。\n\n门14 打回。')
        return 2
    names = sorted(cards, key=len, reverse=True)

    hard, warn = [], []
    # V0.40.8 门精简（作者 2026-09-10 批准）：描述性登记不再逐条输出"跳过项"，
    # 收集后汇总一行。别名会把同一卡注册多次，按卡去重计数。
    desc_items = []
    seen_cards = set()
    for c in cards.values():
        cid = id(c)
        if cid in seen_cards:
            continue
        seen_cards.add(cid)
        if c['禁用原文'] and not c['禁用'] and c['禁用原文'] not in ('—', '-'):
            desc_items.append(('禁用方式', c['禁用原文']))
        if c['口头禅'] and not pet_is_literal(c['口头禅']) \
                and _strip_annot(c['口头禅']) not in ('无', '—', '-'):
            # "无（嘶鸣）"这类 = 该角色无口头禅标记，非登记，不进描述性汇总
            desc_items.append(('口头禅', c['口头禅']))

    for fp in files:
        cn = os.path.splitext(os.path.basename(fp))[0]
        text = open(fp, encoding='utf-8').read()
        dlg = dialogues(text, names)
        by_ch = {}
        for who, seg in dlg:
            by_ch.setdefault(who, []).append(seg)
        for who, segs in by_ch.items():
            card = cards.get(who)
            if not card:
                continue
            joined = '｜'.join(segs)
            # 打回：字面禁用词
            for w in card['禁用']:
                if w and w in joined:
                    hit = [s for s in segs if w in s][0]
                    hard.append(('禁用方式', who, f'{cn} 出现禁用词「{w}」：{hit[:26]}…'))
            # 报警：称呼
            for obj, addr in card['称呼']:
                if obj in joined and addr not in joined:
                    warn.append(('称呼习惯', who,
                                 f'{cn} 对「{obj}」未使用登记称呼「{addr}」'))
            # 报警：口头禅（V0.40.8 仅字面登记触发；描述性风格标签已并入 desc_items 汇总）
            ct = card['口头禅']
            if ct and pet_is_literal(ct) and len(segs) >= 3:
                key = re.sub(r'[「」“”。，]', '', ct)
                if key and key not in re.sub(r'[「」“”。，]', '', joined):
                    warn.append(('口头禅', who,
                                 f'{cn} 说话 {len(segs)} 次，口头禅「{ct}」一次未出现'))
            # 报警：句长偏好
            lens = [len(re.sub(r'\s', '', s)) for s in segs]
            avg = st.mean(lens) if lens else 0
            if '短句' in card['句长'] and avg > args.short_max:
                warn.append(('句长偏好', who,
                             f'{cn} 对白均长 {avg:.0f} 字 > 短句上限 {args.short_max:.0f}'))
            if ('长句' in card['句长'] or '絮叨' in card['句长']) and avg < args.long_min:
                warn.append(('句长偏好', who,
                             f'{cn} 对白均长 {avg:.0f} 字 < 长句下限 {args.long_min:.0f}'))

    print(f'语癖卡：{len(cards)} 个角色名（含别名）｜可判定对白 {sum(1 for _ in QUOTE_RE.finditer("".join(open(f, encoding="utf-8").read() for f in files)))} 段')
    print('\n[打回项]')
    for kind, who, why in hard:
        print(f'  · [{kind}] {who}：{why}')
    if not hard:
        print('  无')
    print('\n[报警项]')
    for kind, who, why in warn:
        print(f'  · [{kind}] {who}：{why}')
    if not warn:
        print('  无')
    if desc_items:
        # V0.40.8 门精简（作者 2026-09-10 批准）：描述性登记不再逐条刷屏，汇总一行。
        print(f'\n[说明] 描述性登记 {len(desc_items)} 项已跳过（非字面口径，不核对不报警）——'
              f'口头禅列只填字面原词、禁用方式写 禁用：词1;词2 才会被核对（README 3.1）。')

    if hard:
        print('\n门14 打回：角色违反了设定表登记的语癖卡。')
        return 2
    print('\n门14 通过（报警项由恶人编辑复核）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())

