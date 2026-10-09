# -*- coding: utf-8 -*-
"""consistency_check.py — 门12 跨章事实一致性（账本驱动，规则书 V0.35）

## 设计原则（作者裁定 2026-09-09）

> **跨章事实一致性必须用文本记录改动，只靠循环没用。**
> 每章新增道具就写进「道具表」；下一章剧情要改，就在表里同步改。
> 这样就不需要"提名"——判据可以直接写成门。

因此本门**不含任何"疑似/需人判"的输出**：所有判据都是「表里写了什么 vs 正文写了什么」的
确定性比对。事实只写在设定表里，脚本里没有任何本书专有名词。

## 数据件（必配，缺表即打回——同门6 的术语表约定）

| 表 | 用于 |
|---|---|
| 道具表 | C1 道具提前出现 / C2 状态互斥 / C3 表自相矛盾 |
| 事件时间表 | C4 时间锚换算 / C5 事件名唯一性 |
| 人物已知信息表 | C6 知识边界越界 |

## 判据（全部打回）

- **C1 道具提前出现**：道具名/别名出现在其「首次出现章」之前的章节 → 打回。
- **C2 道具状态互斥**：某章生效状态为「离场/损毁/封存」，该章正文仍出现该道具 → 打回。
- **C3 道具表自相矛盾**：同一道具同一章登记了两条不同状态 → 打回。
- **C4 时间锚错位**：章绝对日 + 相对时间词偏移，与「相对时间词→指代事件」所指事件的绝对日不符 → 打回；
  正文出现相对时间词但表里未登记口径 → 打回。
- **C5 事件名不唯一**：事件时间表里事件名重复或为空 → 打回（口径无法解析）。
- **C6 知识边界越界**：某人物在「获知章号」之前的章节里与关键词同段出现 → 打回。
- **C7 序数对象空/有互斥**：同一「第X页/行/条/个」既被说成空的、又被说成有墨/有字 → 打回
  （任一句带「可/但/其实/不是空的」等反差标记 → 视为有意反转，放行）。
- **C8 比较句引用空对象**：出现「A比B新/深/旧」而 B 在同书被描述为空 → 打回。

用法：
  python consistency_check.py --chapters "chapters" --tables "设定表_书名.xlsx"
  # --tables 省略时，自动在章节目录及上级目录找 设定表_*.xlsx
"""
import argparse
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from _tables import chap_num, col, day_num, find_tables, load_tables, rows_of  # noqa: E402

# ── 序数对象 / 空有互斥 ─────────────────────────────────────────
ORD = '一二三四五六七八九十百零两0123456789'
KEY_RE = re.compile(r'第([' + ORD + r']{1,4})(行|页|条|个|块|道|具|本|份|根|副|级|阶)')
EMPTY_RE = re.compile(r'(是空的|空着|空白|空的|什么都没写|没有字|没写|留白|没刻)')
FILL_RE = re.compile(r'(墨|字迹|写着|刻着|刻过|笔迹|刀痕|刮过|涂掉|补上去|补的)')
CONTRAST_RE = re.compile(r'(可|但|却|其实|不过|原来|不是空的|并非)')
CMP_RE = re.compile(r'.{1,12}比(第[' + ORD + r']{1,4}(?:行|页|条|个|块|道|具|本|份|根|副))')

# ── 相对时间词（只查可能错位的：±1/±2 天。今天=当日、去年/今年/上个月 无日算意义，不查）──
REL_WORDS = [('前天', -2), ('昨天', -1), ('明天', +1), ('后天', +2)]

DEAD_STATES = ('离场', '损毁', '封存')


def split_sentences(text):
    return [p.strip() for p in re.split(r'(?<=[。！？…”」])', text) if p.strip()]


def paragraphs(text):
    return [p.strip() for p in text.split('\n') if p.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True, help='章节目录（*.md，按文件名排序即章序）')
    ap.add_argument('--tables', default=None, help='设定表工作簿（缺省自动查找 设定表_*.xlsx）')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.chapters, '*.md')))
    if not files:
        print('no chapters', file=sys.stderr)
        return 1
    chaps = [(i, os.path.basename(f), open(f, encoding='utf-8').read())
             for i, f in enumerate(files, 1)]

    tables_path = args.tables
    if not tables_path:
        cands = find_tables(args.chapters)
        tables_path = cands[0] if cands else None

    print('=' * 72)
    print(f'门12 跨章事实一致性（账本驱动）| {len(files)} 章 | 设定表：{tables_path or "未找到"}')
    print('=' * 72)

    if not tables_path or not os.path.exists(tables_path):
        print('\n== 打回 ==')
        print('  [C0 缺数据件] 未找到设定表（需含 道具表/事件时间表/人物已知信息表）。'
              '门12 必配账本，缺表即打回——同门6 的术语表约定。')
        print('\n门12 打回。')
        return 2

    tabs = load_tables(tables_path)
    for need in ('道具表', '事件时间表', '人物已知信息表'):
        if need not in tabs:
            print('\n== 打回 ==')
            print(f'  [C0 缺表] 设定表里没有「{need}」工作表。')
            print('\n门12 打回。')
            return 2

    bad = []
    text_by_ch = {i: t for i, _, t in chaps}

    # ── 道具表：C1 / C2 / C3 ────────────────────────────────────
    props = {}      # 道具名 -> {'aliases':[...], 'first':n, 'states':{ch: state}, 'raw':[(ch,state,holder,loc)]}
    for r in rows_of(tabs, '道具表'):
        name = col(r, '道具名')
        if not name:
            continue
        p = props.setdefault(name, {'aliases': [], 'first': None, 'states': {}, 'rows': []})
        alias = col(r, '别名')
        if alias:
            p['aliases'] += [a for a in re.split(r'[；;、/|]', alias) if a.strip()]
        first = chap_num(col(r, '首次出现章'))
        if first and (p['first'] is None or first[0] < p['first']):
            p['first'] = first[0]
        ch = chap_num(col(r, '章号'))
        state = col(r, '状态')
        if ch:
            c = ch[0]
            if c in p['states'] and p['states'][c] and state and p['states'][c] != state:
                bad.append(('C3 道具表自相矛盾', name,
                            f'第{c}章登记了两个状态：{p["states"][c]} / {state}'))
            p['states'][c] = state or p['states'].get(c, '')
            p['rows'].append((c, state, col(r, '持有者'), col(r, '位置')))

    def mentions(name, p, text):
        """该章正文是否提到这个道具（含别名）。"""
        pats = [re.escape(name)] + [re.escape(a) for a in p['aliases'] if a]
        return [m.group(0) for pat in pats for m in re.finditer(pat, text)]

    for name, p in props.items():
        # C1 提前出现
        if p['first']:
            for ci, _, text in chaps:
                if ci < p['first'] and mentions(name, p, text):
                    bad.append(('C1 道具提前出现', name,
                                f'「{name}」登记首次出现章＝第{p["first"]}章，'
                                f'但第{ci}章正文已出现'))
        # C2 状态互斥
        for ci, _, text in chaps:
            eff = [(c, s) for c, s in sorted(p['states'].items()) if c <= ci and s]
            if not eff:
                continue
            state = eff[-1][1]
            if any(k in state for k in DEAD_STATES) and mentions(name, p, text):
                bad.append(('C2 道具状态互斥', name,
                            f'第{ci}章生效状态＝「{state}」（离场/损毁/封存），'
                            f'但该章正文仍出现「{name}」'))

    # ── 事件时间表：C4 / C5 ─────────────────────────────────────
    events = {}     # 事件名 -> 绝对日
    dup_ev = []
    for r in rows_of(tabs, '事件时间表'):
        name = col(r, '事件')
        day = day_num(col(r, '绝对时间'))
        if not name:
            continue
        if name in events:
            dup_ev.append(name)
            continue
        events[name] = day[0] if day else None
    for name in sorted(set(dup_ev)):
        bad.append(('C5 事件名不唯一', name, f'事件时间表里「{name}」出现多次，口径无法解析'))

    rel_map_re = re.compile(r'([\u4e00-\u9fff]{2,3})\s*[→\-—>]\s*([^；;，,、/|]+)')
    for ci, _, text in chaps:
        rows = [r for r in rows_of(tabs, '事件时间表') if chap_num(col(r, '章号'))[:1] == [ci]]
        D = None
        for r in rows:
            d = day_num(col(r, '绝对时间'))
            if d:
                D = d[0]
                break
        mapping = {}
        for r in rows:
            for w, ev in rel_map_re.findall(col(r, '相对时间词')):
                mapping[w] = ev.strip()
        found = [w for w, _ in REL_WORDS if w in text]
        if not found:
            continue
        if D is None:
            bad.append(('C4 时间锚缺绝对日', f'第{ci}章',
                        '正文出现相对时间词 %s，但事件时间表未登记本章绝对日' % '、'.join(found)))
            continue
        for w in found:
            off = dict(REL_WORDS)[w]
            if w not in mapping:
                bad.append(('C4 时间锚未登记', f'第{ci}章',
                            f'正文出现「{w}」，但事件时间表「相对时间词→指代事件」列未登记口径'))
                continue
            target = mapping[w]
            ev_day = events.get(target)
            if ev_day is None:
                bad.append(('C4 口径引用未知事件', f'第{ci}章',
                            f'「{w}→{target}」指向的事件在事件时间表里查不到'))
                continue
            expect = D + off
            if expect != ev_day:
                bad.append(('C4 时间锚错位', f'第{ci}章',
                            f'本章第{D}天，「{w}」应指第{expect}天，'
                            f'但口径写的「{target}」在第{ev_day}天'))

    # ── 人物已知信息表：C6 ──────────────────────────────────────
    for r in rows_of(tabs, '人物已知信息表'):
        who = col(r, '人物')
        kch = chap_num(col(r, '获知章号'))
        kws = [k.strip() for k in re.split(r'[；;、/|]', col(r, '关键词')) if k.strip()]
        if not (who and kch and kws):
            continue
        K = kch[0]
        for ci, _, text in chaps:
            if ci >= K:
                continue
            for para in paragraphs(text):
                if who not in para:
                    continue
                hit = [k for k in kws if k in para]
                if hit:
                    bad.append(('C6 知识边界越界', who,
                                f'「{who}」登记获知章＝第{K}章，但第{ci}章同段出现关键词'
                                f'「{"、".join(hit)}」：…{para[:34]}…'))
                    break

    # ── C7 / C8 序数对象空有互斥 ────────────────────────────────
    key_ctx = {}
    for ci, _, text in chaps:
        for s in split_sentences(text):
            for m in KEY_RE.finditer(s):
                key_ctx.setdefault(m.group(0), []).append((ci, s))
    for key, occ in sorted(key_ctx.items()):
        empt = [(ci, s) for ci, s in occ if EMPTY_RE.search(s)]
        fill = [(ci, s) for ci, s in occ if FILL_RE.search(s)]
        if not (empt and fill):
            continue
        if any(CONTRAST_RE.search(s) for _, s in empt + fill):
            continue          # 有意反转，放行
        bad.append(('C7 序数对象空/有矛盾', key,
                    f'第{empt[0][0]}章「{empt[0][1][:30]}」↔ 第{fill[0][0]}章「{fill[0][1][:30]}」'))
    empty_keys = {k for k, occ in key_ctx.items()
                  if any(EMPTY_RE.search(s) for _, s in occ)}
    for ci, _, text in chaps:
        for s in split_sentences(text):
            for m in CMP_RE.finditer(s):
                if m.group(1) in empty_keys:
                    bad.append(('C8 比较句引用空对象', m.group(1),
                                f'第{ci}章「{s[:40]}」但 {m.group(1)} 被描述为空'))

    # ── 输出 ────────────────────────────────────────────────────
    print(f'\n道具表 {len(props)} 件 / 事件时间表 {len(events)} 个事件 / '
          f'人物已知信息表 {len(rows_of(tabs, "人物已知信息表"))} 条')
    if bad:
        print('\n== 打回 ==')
        for kind, key, why in bad:
            print(f'  [{kind}] {key}\n      {why}')
        print('\n门12 打回。改表或改正文后复跑。')
        return 2
    print('\n== 打回 ==\n  无。')
    print('\n门12 通过（全部为账本比对，无提名项）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
