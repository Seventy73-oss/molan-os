# -*- coding: utf-8 -*-
"""build_context.py — 本章注入包生成器（S1，作者已批；V0.41 减负改造）

## 解决什么

规则书要求每章生成前注入 7 类东西（规划表/beat/配额余额/病灶库/语域卡/风格锚点/语癖卡）。
**以前靠人工挑，每章一次 → 漏注入是常态。现在一条命令拼成一个文件。**

## V0.41 减负改造（作者诉求：注入包太大≈8,200字/次，AI 扭头就忘，token 贵）

**默认精简模式**：只拼写手必需 8 类，目标 ≤3,500 字：
  一、本章 beat（细纲表该章一行）／二、本章规划表（有 --plan 时只带关键列）
  三、人物语癖卡（只列该章已出场角色）／四、账本状态（只列与本章相关行）
  五、真人基线目标值（章级档 12 个关键指标，一行一项）
  六、病灶库 Top5（原 Top10＋最近10 压成 5 条高频）
  七、黑名单速查（压成一行关键词）
  八、题材档注入指令（按 --genre 自动取 文风靶板_分题材/<档>.md 的"注入指令"节）
     ＋ 中文腔禁词铁禁 regex 一行（11_skills包/中文腔禁词清单_v2.json）
**全量开关**：`--full` 恢复原 11 板块（病灶 Top10＋最近10、语域卡、写作层目标 W1~W11、
  配额余额、上一章实测、完整基线表等）并追加"十二、题材档写作指令"。
`--slim` 可显式指定精简（默认即精简）。旧命令不带任何新参数＝精简，不报错。

## 用法

  # 精简（默认；写手日常）
  python build_context.py --chapter 第02章 \
      --tables "14_新书_AI大法师/00_设定表.xlsx" \
      --genre  "西幻/异世界" \
      --terms  "14_新书_AI大法师/术语表_AI大法师.txt" \
      --out    "14_新书_AI大法师/_context/第02章_注入包.md"

  # 全量（排查/审稿要完整口径时）
  python build_context.py --full --chapter 第02章 \
      --tables "…" --plan "…/02_规划表_第02章.md" --genre "西幻/异世界" \
      --chapters-dir "…/chapters" --terms "…" --out "…/第02章_注入包_full.md"

注：本次一并把 RULEBOOK 常量从已归档的 规则书_V0.36.md 指到现行 规则书_V0.40.md
（否则黑名单节读不到文件恒为空）。
"""
import argparse
import glob
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from _tables import chap_num, col, load_tables, rows_of  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, '..', '11_skills包')
RULEBOOK = os.path.join(PKG, '规则书_V0.40.md')  # V0.41：V0.36 已归档，指现行版本
GENRECARD = os.path.join(PKG, '语域卡_分档.md')
DISEASE = os.path.join(PKG, '病灶库.md')
QUOTA = os.path.join(PKG, '配额账本.json')
TARGET_DIR = os.path.join(PKG, '文风靶板_分题材')   # V0.41 新增：分题材文风靶板
BANWORD = os.path.join(PKG, '中文腔禁词清单_v2.json')  # V0.41 新增：禁词铁禁 regex
TARGET_INDEX = '00_总索引与用法.md'                  # 靶板目录里的非题材档说明，跳过
# 精简目标字数（作者口径）；超出仅提示不报错
SLIM_TARGET = 3500


def read(p):
    return io.open(p, encoding='utf-8').read() if p and os.path.exists(p) else ''


def section(text, header_pat, stop_pat=r'^## '):
    """取某个二级标题到下一个二级标题之间的正文。"""
    m = re.search(header_pat, text, re.M)
    if not m:
        return ''
    start = m.end()
    m2 = re.search(stop_pat, text[start:], re.M)
    return text[start:start + m2.start()].strip() if m2 else text[start:].strip()


def disease_top10():
    t = read(DISEASE)
    return section(t, r'^## 频率Top10[^\n]*\n', r'^## ')


def disease_recent(n=10):
    t = read(DISEASE)
    blocks = re.split(r'(?m)^### ', t)[1:]
    out = []
    for b in blocks[-n:]:
        title = b.split('\n', 1)[0].strip()
        body = b.split('\n', 1)[1] if '\n' in b else ''
        body = re.split(r'(?m)^### |^## ', body)[0].strip()
        out.append((title, body))
    return out


def genre_card(genre):
    t = read(GENRECARD)
    if not genre:
        return ''
    base = section(t, r'^## 一、分档基线表[^\n]*\n', r'^## ')
    # 该档基线行
    row = [l for l in base.split('\n') if genre.split('/')[0] in l]
    anchor = section(t, r'^## 二、各档锚点样本[^\n]*\n', r'^## ')
    anchors = [b for b in re.split(r'(?m)^### ', anchor)[1:]
               if genre.split('/')[0] in b.split('\n', 1)[0]]
    parts = []
    if row:
        parts.append('【基线行】\n' + '\n'.join(row))
    for a in anchors[:2]:
        parts.append('【锚点样本】\n### ' + a.strip()[:600])
    return '\n\n'.join(parts)


def blacklist():
    t = read(RULEBOOK)
    return section(t, r'^## 四、黑名单速查[^\n]*\n', r'^## ')


def _load_baseline(genre, path):
    """读章级基线 JSON，返回 (档数据 g, 实际档名)。找不到档回退 all。"""
    d = json.load(io.open(path, encoding='utf-8')) if os.path.exists(path) else {}
    g = (d.get('genres') or {}).get(genre)
    if not g:
        for k in (d.get('genres') or {}):
            if genre and genre.split('/')[0] in k:
                g = d['genres'][k]
                genre = k
                break
    if not g:
        g = d.get('all')
    return g, genre


def baseline_for(genre, path):
    """章级基线（V0.38 换用：与单章 3000 字同长度，避免长度错配）。"""
    g, genre = _load_baseline(genre, path)
    if not g:
        return ''
    # (键, 中文名, 方向, 小数位)  方向 low=下限 high=上限 lowp25=低于p25报警
    spec = [('smean', '均句长', 'low', 1), ('ssd', '句长sd', 'low', 1),
            ('pmean', '均段长', 'high', 1), ('psd', '段长sd', 'high', 1),
            ('dlg_pct', '对白段%', 'low', 1), ('env2_pct', '环境段%严格', 'high', 1),
            ('said_kilo', '说族/千字', 'high', 2), ('simile_kilo', '明喻/千字', 'high', 2),
            ('conn_nat_kilo', '承接词自然/千字', 'low', 2),
            ('conn_kilo', '承接词AI/千字', 'high', 2),
            ('head_rep', '句首重复率', 'high', 3), ('pol_sd', '情感极性sd', 'low', 3),
            ('pol_turns_kilo', '情感转折/千字', 'lowp25', 2),
            ('pol_pos_pct', '正向句%', 'low', 1), ('pol_neg_pct', '负向句%', 'low', 1)]
    arrow = {'low': '≥', 'high': '≤', 'lowp25': '≥'}
    lines = [f'题材档：{genre}（章级样本 n={g.get("n")}，每样本 3000 字）', '',
             '| 指标 | 硬底线（越界报警） | 目标带（p25~p75） | min | med | max |',
             '|---|---|---|---|---|---|']
    for k, lab, direction, nd in spec:
        v = g.get(k)
        if not v:
            continue
        f = '{:.%df}' % nd
        hard = ('%s %s' % (arrow[direction], f.format(
            v['p25'] if direction == 'lowp25' else (v['min'] if direction == 'low' else v['max']))))
        lines.append('| %s | **%s** | %s~%s | %s | %s | %s |' % (
            lab, hard, f.format(v['p25']), f.format(v['p75']),
            f.format(v['min']), f.format(v['med']), f.format(v['max'])))
    lines += ['', '> 判定原则（规则书门7）：区间门不是点门；章级宽松、卷级严格；'
                  '**连续 3 章同向越界才打回**；章数 ≥10 时中位数须落 p25~p75。',
              '> ⚠️ 杂讯下限**不设**（已证伪：真人 3000 字窗口 57% 零杂讯）。']
    return '\n'.join(lines)


CONN_WHITELIST = ('不过', '只是', '虽然', '所以', '可是', '同时', '之后', '甚至',
                  '而且', '结果', '这才', '反而', '再说', '接着', '然后', '接下来',
                  '另外', '后来', '然而', '于是', '反正', '等到', '但是', '至少',
                  '因此', '过后', '何况', '随后', '尤其', '第二天', '那天', '尽管',
                  '随即', '反倒', '难怪', '偏偏', '跟着', '回头', '半晌', '过了一会儿',
                  '没多久', '不多时', '片刻后', '当晚', '转眼', '况且', '再者',
                  '说到底', '无论如何', '好歹', '因而', '故而', '由此', '总之')


def writing_targets(genre, chapter_baseline, ppl_baseline=None):
    """W1~W7 写作层目标（把七维度缺口翻成写作指令）。"""
    d = json.load(io.open(chapter_baseline, encoding='utf-8')) \
        if os.path.exists(chapter_baseline) else {}
    g = (d.get('genres') or {}).get(genre) or d.get('all') or {}
    if not g:
        return ''
    ppl = {}
    if ppl_baseline and os.path.exists(ppl_baseline):
        pd = json.load(io.open(ppl_baseline, encoding='utf-8'))
        ppl = (pd.get('genres') or {}).get(genre) or pd.get('all') or {}
    sm = g.get('smean', {})
    ssd = g.get('ssd', {})
    psd = g.get('psd', {})
    pol = g.get('pol_sd', {})
    turns = g.get('pol_turns_kilo', {})
    conn = g.get('conn_nat_kilo', {})
    out = ['### 4.1 W1 句长预算（治"句子太短"）', '',
           '- 本章**均句长目标 %s~%s 字**（硬底线 ≥ %s）；句长 sd 目标 %s~%s（硬底线 ≥ %s）。' % (
               sm.get('p25'), sm.get('p75'), sm.get('min'),
               ssd.get('p25'), ssd.get('p75'), ssd.get('min')),
           '- 每段至少 **1 个 ≥30 字的复句**（逗号链/从句）；全章至少 **3 个 ≥45 字长句**。',
           '- 规划表「句长预算」列逐段标注，写完核对本章实测均句长是否落在目标带。', '',
           '### 4.2 W2 承接词（治"衔接被清成零"）', '',
           '- 用**真人实际在用的衔接词**（每千字 %s~%s 处）：%s。' % (
               conn.get('p25'), conn.get('p75'), '、'.join(CONN_WHITELIST[:24])),
           '- **不要**用 AI 腔连接词堆（因此/所以/然而/于是/另一方面/更重要的是）——'
           '它们每千字 ≤%s 处。' % g.get('conn_kilo', {}).get('max', 3.5), '',
           '### 4.3 W3 低概率词注入（治"文本太可预测"）', '',
           '- 本章 2~3 处：冷门但准确的动词/名词、具体器物名、非典型搭配；**叙述层仍白话**。',
           '- 困惑度目标：**≥ %s**（西幻 p10）；nll_std ≥ %s。**禁止越写越顺**（连续下降＝机器指纹）。' % (
               ppl.get('perplexity', {}).get('p10', '—'), ppl.get('nll_std', {}).get('p10', '—')), '',
           '### 4.4 W4 章间锚定（治"风格单调漂移"）', '',
           '- 见第八节「上一章实测指标」：本章目标带取上一章与档位 p25~p75 的交集，'
           '**不得连续 3 章同向偏移 ≥15%**（门7 D17）。',
           '- 段长 sd 目标 %s~%s（硬上限 %s）：禁止"前几段极短、后几段极长"的极端分布。' % (
               psd.get('p25'), psd.get('p75'), psd.get('max')), '',
           '### 4.5 W5 感官替代通用环境词（治"环境段过密"）', '',
           '- 环境段%%严格目标 ≤ %s（硬上限）；少堆"雨/光/墙/门/风"通用词，'
           '换成**具体感官**：温度、气味、手上的触感、声音的方位。' % g.get('env2_pct', {}).get('max'), '',
           '### 4.6 W6/W7 修辞与引述动词（治"修辞单一/引述偏多"）', '',
           '- 明喻 ≤ %s/千字；同一明喻引导词 ≤3 次/章；超量时改用动作/身体感/留白。' % (
               g.get('simile_kilo', {}).get('max'),),
           '- 说族 ≤ %s/千字（与门3 占比门并行）；至少 **1/3 的对话不带言语动词**'
           '（用动作拍），并轮换问/答/念/讲。' % g.get('said_kilo', {}).get('max'), '',
           '### 4.7 情感波动（治"情感太平"）', '',
           '- 情感极性 sd ≥ %s（硬底线）；情感转折 ≥ %s 处/千字（3000 字章至少 **%d 个明显情绪转向**）。' % (
               pol.get('min'), turns.get('p25'),
               max(2, int(round(turns.get('p25', 1.0) * 3)))),
           '- 正向句%% ≥ %s、负向句%% ≥ %s：**别通篇中性叙述**——该高兴就写高兴，'
           '该厌恶就写厌恶，情绪要落在具体词上。' % (
               g.get('pol_pos_pct', {}).get('min'), g.get('pol_neg_pct', {}).get('min')), '',
           # ── V0.39：语言表层纪律（作者 2026-09-10 反馈，朱雀复检 0.648 驱动）──
           '### 4.8 W8 用词：禁单字癖（实测我们 60.3% vs 真人 36.5%）', '',
           '- **能用双音节就双音节**：嚼→咀嚼｜咽→吞咽｜递→递交/上交｜顶→顶住｜些→**一些**｜清楚→**很清楚**。',
           '- 目标：单字动词 ≤45%、单字名词 ≤16%；固定搭配与口语短句（"说吧""走了"）不强行扩写。', '',
           '### 4.9 W9 修辞：八种要齐（实测我们 4~5 种 vs 真人 8 种）', '',
           '- 全章 ≥6 种修辞；**设问 ≥1、反问 ≥1、夸张 ≥1、拟人 ≥1**（这四项我们目前全为 0）。',
           '- 明喻 ≤2.2/千字（真人 p75）；**排比 ≤2/千字、对偶 ≤0.6/千字**——我们排比是真人 2.6 倍、对偶 3.4 倍。', '',
           '### 4.10 W10 情绪色彩：词表密度要够（实测我们 9.5 vs 真人 17.98）', '',
           '- 情绪词密度 **≥15/千字**；用具体情绪词，不用概括（不写"他很生气"，写"他攥得指节发白"）。',
           '- 同一章至少覆盖 **3 类**情绪（喜/怒/惧/惊/悲/厌/羞/期待/委屈/心疼…）。', '',
           '### 4.11 W11 标点：正确使用，而不是少用（作者裁定）', '',
           '- 下限：**问号 ≥2.3/千字、叹号 ≥1.5、省略号 ≥0.4、顿号 ≥0.7**。',
           '- 疑问句**一律用问号**，不许句号收尾；该叹就叹、该停就停（省略号）。',
           '- 句号密度会自然从 47.7 回落到真人档 25.6~33.4——**不是因为少用句号，是因为用对了别的标点**。', '']
    return '\n'.join(out)


def voice_cards(tabs):
    out = []
    for sheet in ('主角设定表', '配角设定表'):
        for r in rows_of(tabs, sheet):
            name = col(r, '姓名')
            if not name:
                continue
            out.append('| ' + ' | '.join([
                name, col(r, '口头禅') or '—', col(r, '句长偏好') or '—',
                col(r, '标点习惯') or '—', col(r, '损法', '损法/怼人方式') or '—',
                col(r, '称呼习惯') or '—',
                col(r, '禁用方式', '禁用方式（绝不这么说）') or '—']) + ' |')
    if not out:
        return ''
    return ('| 角色 | 口头禅 | 句长偏好 | 标点 | 损法 | 称呼 | 禁用 |\n'
            '|---|---|---|---|---|---|---|\n' + '\n'.join(out)
            + '\n\n> 门14 会拿这张表逐句核对对白：禁用词字面命中即打回；'
              '称呼/口头禅/句长偏差报警。')


def voice_cards_slim(tabs, n):
    """V0.41：只列第 n 章写作时**已出场**角色（首次出场章 ≤ n），不列全书角色。"""
    cards = []
    has_first_chap_col = False
    for sheet in ('主角设定表', '配角设定表'):
        for r in rows_of(tabs, sheet):
            name = col(r, '姓名')
            if not name:
                continue
            ch = chap_num(col(r, '首次出场章', '出场章'))
            if ch:
                has_first_chap_col = True
            cards.append((name, r, ch))
    if not cards:
        return ''
    if has_first_chap_col:
        # 表里有首次出场章列 → 只留已出场的（无章号的行视为常驻，保留）
        keep = [c for c in cards if (not c[2]) or min(c[2]) <= n]
    else:
        # 表无出场列 → 用事件时间表（≤n）的在场人物 ∩ 角色名 推断谁已出场；
        # 事件表空则退化为全列（信息不足，宁全勿漏）
        acted = []
        for r in rows_of(tabs, '事件时间表'):
            if (chap_num(col(r, '章号')) or [0])[0] <= n:
                acted.append(col(r, '在场人物') or '')
        pool = ' '.join(acted)
        keep = []
        for name, r, ch in cards:
            base = name.split('（')[0].split('(')[0]
            if (not pool) or base in pool:
                keep.append((name, r, ch))
    out = []
    for name, r, _ in keep:
        out.append('| ' + ' | '.join([
            name, col(r, '口头禅') or '—', col(r, '句长偏好') or '—',
            col(r, '标点习惯') or '—', col(r, '损法', '损法/怼人方式') or '—',
            col(r, '称呼习惯') or '—',
            col(r, '禁用方式', '禁用方式（绝不这么说）') or '—']) + ' |')
    if not out:
        return ''
    return ('| 角色 | 口头禅 | 句长偏好 | 标点 | 损法 | 称呼 | 禁用 |\n'
            '|---|---|---|---|---|---|---|\n' + '\n'.join(out)
            + '\n\n> 只列第 %d 章前已出场角色。门14 逐句核对对白：禁用词字面命中即打回；'
              '称呼/口头禅/句长偏差报警。' % n)


def ledger_state(tabs, n):
    """账本状态：≤ 本章的道具/事件/已知信息。"""
    parts = []
    props = [r for r in rows_of(tabs, '道具表')
             if (chap_num(col(r, '章号')) or [0])[0] <= n]
    if props:
        parts.append('**道具表（≤本章）**\n\n| 道具 | 章号 | 状态 | 持有者 | 位置 |\n|---|---|---|---|---|\n'
                     + '\n'.join('| ' + ' | '.join([
                         col(r, '道具名'), col(r, '章号'), col(r, '状态'),
                         col(r, '持有者'), col(r, '位置')]) + ' |'
                         for r in props[-15:]))
    ev = [r for r in rows_of(tabs, '事件时间表')
          if (chap_num(col(r, '章号')) or [0])[0] <= n]
    if ev:
        parts.append('**事件时间表（≤本章）**\n\n| 章号 | 绝对时间 | 事件 |\n|---|---|---|\n'
                     + '\n'.join('| ' + ' | '.join([
                         col(r, '章号'), col(r, '绝对时间'), col(r, '事件')]) + ' |'
                         for r in ev[-15:]))
    kn = [r for r in rows_of(tabs, '人物已知信息表')
          if (chap_num(col(r, '获知章号')) or [0])[0] <= n]
    if kn:
        parts.append('**人物已知信息（≤本章）**\n\n| 人物 | 获知章 | 内容 |\n|---|---|---|\n'
                     + '\n'.join('| ' + ' | '.join([
                         col(r, '人物'), col(r, '获知章号'), col(r, '获知内容')]) + ' |'
                         for r in kn[-15:]))
    return '\n\n'.join(parts)


def _relevant_k(tabs, n):
    """V0.41：算"与本章相关"的章号——本章有行→本章；否则最近已填章（≤n）；全空→0。"""
    ks = []
    for sheet, colname in (('道具表', '章号'), ('事件时间表', '章号'),
                           ('人物已知信息表', '获知章号')):
        for r in rows_of(tabs, sheet):
            c = chap_num(col(r, colname))
            if c and c[0] <= n:
                ks.append(c[0])
    return n if n in ks else (max(ks) if ks else 0)


def ledger_state_slim(tabs, n):
    """V0.41：账本只给**与本章相关**行（k=本章或最近已填章）——
    道具表=每道具最后一次 ≤k 记录（当前状态）；事件=第 k 章全部；已知信息=第 k 章全部。"""
    k = _relevant_k(tabs, n)
    if not k:
        return ''
    note = '（章 %d = 与本章相关%s）' % (k, '，即最近已填章' if k != n else '')
    parts = []

    # 1) 道具：每道具最后一次 ≤k 记录
    best = {}
    for i, r in enumerate(rows_of(tabs, '道具表')):
        c = chap_num(col(r, '章号'))
        if not c or c[0] > k:
            continue
        key = col(r, '道具名') or '行%d' % (i + 1)
        cur = (c[0], i)
        if key not in best or cur > best[key][0]:
            best[key] = (cur, r)
    if best:
        lines = []
        for key in sorted(best, key=lambda x: (best[x][0][0], best[x][0][1])):
            _, r = best[key]
            lines.append('| ' + ' | '.join([
                col(r, '道具名') or '—',
                str(best[key][0][0]),
                col(r, '状态（在场/离场/损毁/封存/易主）', '状态（在场/离场）', '状态') or '—',
                col(r, '持有者') or '—', col(r, '位置') or '—']) + ' |')
        parts.append('**道具表·当前状态**（每道具最近记录）\n\n'
                     '| 道具 | 章 | 状态 | 持有者 | 位置 |\n|---|---|---|---|---|\n'
                     + '\n'.join(lines))

    # 2) 事件：第 k 章（与本章最相关，防止接缝重复；上限 12 行）
    ev = [r for r in rows_of(tabs, '事件时间表')
          if (chap_num(col(r, '章号')) or [0])[0] == k][-12:]
    if ev:
        lines = ['| ' + ' | '.join([
            col(r, '章号'), col(r, '时段') or '—', (col(r, '事件') or '—'),
            col(r, '在场人物') or '—']) + ' |' for r in ev]
        parts.append('**事件时间表·第%d章**（含上一章收尾避免接缝重复）\n\n'
                     '| 章 | 时段 | 事件 | 在场人物 |\n|---|---|---|---|\n' % k
                     + '\n'.join(lines))

    # 3) 已知信息：第 k 章（谁此时知道了什么；上限 10 行）
    kn = [r for r in rows_of(tabs, '人物已知信息表')
          if (chap_num(col(r, '获知章号')) or [0])[0] == k][-10:]
    if kn:
        lines = ['| ' + ' | '.join([
            col(r, '人物'), col(r, '获知章号'), (col(r, '获知内容') or '—')]) + ' |'
            for r in kn]
        parts.append('**人物已知信息·第%d章**\n\n| 人物 | 获知章 | 内容 |\n|---|---|---|\n' % k
                     + '\n'.join(lines))
    if not parts:
        return ''
    return note + '\n\n' + '\n\n'.join(parts)


def baseline_slim(genre, path):
    """V0.41：章级档基线，只列 12 个关键指标，每指标一行（硬底线＋目标带）。"""
    g, genre = _load_baseline(genre, path)
    if not g:
        return ''
    # (键, 中文名, 方向, 小数位)；方向 low=下限 high=上限 lowp25=低于p25报警
    spec = [('smean', '均句长', 'low', 1), ('ssd', '句长sd', 'low', 1),
            ('pmean', '均段长', 'high', 1), ('psd', '段长sd', 'high', 1),
            ('dlg_pct', '对白段%', 'low', 1), ('env2_pct', '环境段%严格', 'high', 1),
            ('said_kilo', '说族/千字', 'high', 2), ('simile_kilo', '明喻/千字', 'high', 2),
            ('conn_nat_kilo', '承接词自然/千字', 'low', 2),
            ('conn_kilo', '承接词AI/千字', 'high', 2),
            ('pol_sd', '情感极性sd', 'low', 3), ('pol_turns_kilo', '情感转折/千字', 'lowp25', 2)]
    arrow = {'low': '≥', 'high': '≤', 'lowp25': '≥'}
    lines = [f'题材档：{genre}（章级 n={g.get("n")}，每样本 3000 字；写手盯这 12 项）', '']
    for k, lab, direction, nd in spec:
        v = g.get(k)
        if not v:
            continue
        f = '{:.%df}' % nd
        hv = v['p25'] if direction == 'lowp25' else (v['min'] if direction == 'low' else v['max'])
        lines.append('- %s：硬底线 %s %s｜目标带 %s~%s' % (
            lab, arrow[direction], f.format(hv), f.format(v['p25']), f.format(v['p75'])))
    lines += ['',
              '> 区间门不是点门：连续 3 章同向越界才打回；句首重复率/正负向句%等观察项见 --full。']
    return '\n'.join(lines)


def disease_top5():
    """V0.41：病灶只给频率 Top5（T1~T5），完整 Top10＋最近案例见 --full。"""
    t10 = disease_top10()
    if not t10:
        return ''
    ls = [ln for ln in t10.split('\n') if ln.strip()]
    return '\n'.join(ls[:5])


def blacklist_one_line(maxlen=360):
    """V0.41：黑名单压成一行关键词（示例词连排，AI 自查命中即改）。"""
    t = read(RULEBOOK)
    sec = section(t, r'^## 四、黑名单速查[^\n]*\n', r'^## ')
    if not sec:
        return ''
    flat = []
    for ln in sec.split('\n'):
        s = ln.strip().lstrip('-•* ').strip()
        s = re.sub(r'\s+', '', s)
        s = s.replace('**', '')
        if s:
            flat.append(s)
    line = '｜'.join(flat)
    if len(line) > maxlen:
        line = line[:maxlen] + '…'
    return '> 禁（命中即改，一行自查）：' + line


def target_file(genre):
    """V0.41：按 --genre 主段（如 西幻/异世界 → 西幻）在 文风靶板_分题材/ 里定位档文件。"""
    if not genre or not os.path.isdir(TARGET_DIR):
        return None
    seg = genre.split('/')[0]
    for f in sorted(os.listdir(TARGET_DIR)):
        if not f.endswith('.md') or f == TARGET_INDEX:
            continue
        base = os.path.splitext(f)[0]
        name = base.split('_', 1)[-1] if '_' in base else base
        if seg and (seg in name or name in seg):
            return os.path.join(TARGET_DIR, f)
    return None


def target_list():
    """V0.42：列出全部题材档文件名（缺档告警时给写手看的可选项）。"""
    if not os.path.isdir(TARGET_DIR):
        return []
    return sorted(f for f in os.listdir(TARGET_DIR)
                  if f.endswith('.md') and f != TARGET_INDEX)


MISSING_NOTE = ('> ⚠️ **未匹配到题材档靶板**：`--genre` = 「%s」。\n'
                '> 现有档：%s。\n'
                '> 处置（三选一）：① 把 `--genre` 改成上列档名之一；'
                '② 在 `11_skills包/文风靶板_分题材/` 新建该档——必须同时含「注入指令」节与'
                '「最小范本集」节，且范本只能取自真人语料并标出处；'
                '③ 坚持无档写作——则本包**不提供任何文风范本与档位数字**，'
                '写手须自行声明语域，并自负跑门失败。\n'
                '> ⚠️ 见到本行即代表**文风未受控**，不要当作"本档无特殊要求"直接开写。')


def _sec_split(lines):
    """按 '## ' 一级节切分 → [(标题行, 正文行list)]。只认 ## ，### / #### 不切。"""
    idx = [i for i, ln in enumerate(lines) if ln.startswith('## ')]
    out = []
    for k, i in enumerate(idx):
        j = idx[k + 1] if k + 1 < len(idx) else len(lines)
        out.append((lines[i], lines[i + 1:j]))
    return out


MIN_EXEM_KEY = '最小范本集'

# 精简包：靶板节内可用该标记圈出"精简摘要"，slim 模式下只带这一块。
SUM_RE = re.compile(r'<!--SLIM_SUMMARY_START-->(.*?)<!--SLIM_SUMMARY_END-->', re.S)


def _min_exemplars(lines):
    """V0.42：抽靶板的「最小范本集」节——注入包必须自带"真人原句长这样"，
    否则写手只拿到抽象指令（"去读模板X"），等于没拿到文风。"""
    for title, body in _sec_split(lines):
        if MIN_EXEM_KEY in title:
            s = '\n'.join(body).strip()
            s = re.sub(r'(?m)^-{3,}\s*$', '', s)
            s = re.sub(r'\n{3,}', '\n\n', s).strip()
            return s
    return ''


def injection_instructions(genre, slim=False, missing_note=False):
    """V0.42：取目标档靶板的「注入指令」节及其后所有节，并把「最小范本集」置顶拼在最前。

    V0.41.1：只取单节 → 已改为取注入指令节及其后所有节（含作者点名禁例、译本腔补充）。
    V0.42 三处修正（2026-09-11 注入体检）：
      C1 范本缺失——注入包过去只有"去读模板X"的指路牌，没有一句真人原句；
         现从靶板抽「最小范本集」节并**置顶**，保证写手先看见"长这样"再看"怎么做"。
      C2 静默失效——target_file 返回 None 时过去返回空串，调用方 `if inj:` 直接跳过，
         注入包里**连一行提示都没有**，写手以为什么都没发生；现可返回告警块。
      C4 精简包超重——slim=True 时按靶板侧的两类显式标记裁剪：
         标题带 `<!--SLIM_SKIP-->` 的节整节跳过（用于与 banword_line 一行 regex 重复的铁禁表）；
         正文带 `<!--SLIM_SUMMARY_START-->…END-->` 的节只带摘要块。
         西幻档由此从 6,152 字降到 ~3,385 字（目标 ≤3,500），且范本与对白骨架都还在。
    """
    f = target_file(genre)
    if not f:
        if missing_note:
            names = '、'.join(os.path.splitext(x)[0] for x in target_list())
            return MISSING_NOTE % (genre, names or '（目录为空或不存在）')
        return ''
    lines = read(f).split('\n')
    secs = _sec_split(lines)
    start = None
    for i, (title, _) in enumerate(secs):
        if '注入' in title and '指令' in title:
            start = i
            break
    if start is None:
        return ''
    # 裁剪开关（精简包专用，两档，靶板侧显式标记，代码不硬编码节名）：
    #   ① 标题带 <!--SLIM_SKIP--> 的节 → 整节跳过（用于与 banword_line 一行 regex 重复的铁禁表）；
    #   ② 正文含 <!--SLIM_SUMMARY_START-->…<!--SLIM_SUMMARY_END--> 的节 → 只带摘要块。
    # 保证 --full ⊇ 精简，且不会误删"对白长什么样"这类正向骨架。
    picked = secs[start:]
    parts = []
    for title, body in picked:
        if slim and '<!--SLIM_SKIP-->' in title:
            continue
        b = '\n'.join(body)
        m = SUM_RE.search(b)
        if m:
            if slim:
                b = m.group(1).strip() + \
                    '\n\n> （本节精简包只带摘要；需要逐条骨架时看靶板全文或加 `--full`。）'
            else:  # 全量包：保留整节，只剥掉标记注释行
                b = re.sub(r'<!--SLIM_SUMMARY_(?:START|END)-->\n?', '', b)
        parts.append(title + '\n' + b)
    seg = '\n'.join(parts)
    seg = re.sub(r'(?m)^-{3,}\s*$', '', seg)          # 去纯 --- 分隔
    seg = re.sub(r'(?m)^\*靶板制作说明[^\n]*', '', seg)  # 去靶板制作元注释
    seg = re.sub(r'\n{3,}', '\n\n', seg).strip()
    ex = _min_exemplars(lines)
    if ex:
        seg = ex + '\n\n' + seg                        # 范本置顶
    else:
        seg = ('> ⚠️ 本档靶板缺「最小范本集」节——注入包只有抽象指令、没有真人原句，'
               '文风未受控。请补写该节（2~3 条真人摘句＋出处）后再跑本包。\n\n') + seg
    return seg


def banword_line():
    """V0.41：中文腔禁词清单的铁禁 regex 压成一行（命中叙述/对白层一律改）。"""
    t = read(BANWORD)
    if not t:
        return ''
    try:
        d = json.loads(t)
    except Exception:
        return ''
    rx = (d.get('regex_铁禁') or '').strip()
    if not rx:
        return ''
    nban = len([w for w in (d.get('regex_铁禁') or '').split('|') if w.strip()]) or len(d.get('铁禁') or [])
    nex = len(d.get('豁免') or [])
    return ('> 中文腔铁禁 regex（叙述层与对白层一律禁，命中即改；%d 词）：%s\n'
            '> （豁免 %d 项＝作者钦点现代梗/改稿原句等，只在其钦点语境放行；'
            '若铁禁词与真人批注已认可的台词措辞冲突，以批注口径为准。'
            '完整清单：11_skills包/中文腔禁词清单_v2.json）' % (nban, rx, nex))


def beat_row(tabs, n):
    for r in rows_of(tabs, '章节细纲表'):
        if (chap_num(col(r, '章号')) or [0])[0] == n:
            keys = ['章名', '目标字数', '失控事件', '实际代价', '未解决尾巴', '失败章',
                    '情绪崩口位', '蓄势位', '章节标题风格', '章尾模式', '句式偏好', '禁用收口']
            return '\n'.join(f'- **{k}**：{col(r, k) or "—"}' for k in keys)
    return ''


def quota_balance(files, current):
    """间隔制余额：从已写章节里找每个句式最后出现的章号。"""
    if not os.path.exists(QUOTA):
        return ''
    q = json.load(io.open(QUOTA, encoding='utf-8'))['quotas']
    pats = {
        '我以为的X/实际上的X': r'我以为的.{1,12}[:：]|实际上的.{1,12}[:：]',
        '不是A不是B是C': r'不是.{1,10}，?不是.{1,10}，?(而是|是)',
        '好家伙': r'好家伙', '行吧': r'行吧', '这波': r'这波', '拿捏': r'拿捏',
        '看了很久/半天': r'看了(很久|半天)', '一行字': r'一行字',
    }
    texts = [(os.path.basename(f), read(f)) for f in files]
    rows = []
    for group, items in q.items():
        for name, spec in items.items():
            if 'interval_min' not in spec:
                continue
            pat = pats.get(name)
            if not pat:
                continue
            chs = [chap_num(t)[0] if chap_num(t) else i for i, (t, _) in enumerate(texts, 1)
                   if re.search(pat, _)]
            last = max(chs) if chs else None
            need = spec['interval_min']
            left = '可用' if last is None else max(0, need - (current - last))
            rows.append(f'| {name} | {need} | {last or "—"} | '
                        f'{"—" if last is None else left} |')
    if not rows:
        return ''
    return ('| 句式 | 最小间隔 | 上次出现章 | 距可用还需 |\n|---|---|---|---|\n'
            + '\n'.join(rows))


def prev_metrics(chapter_files, current):
    """上一章实测指标（供章间锚定）。"""
    prev = [f for f in chapter_files if (chap_num(os.path.basename(f)) or [0])[0] == current - 1]
    if not prev:
        return ''
    try:
        from narrative_probe import probe  # 复用探针
        r = probe(read(prev[0]), os.path.basename(prev[0]))
        return (f"- 均句长 {r['smean']:.1f}｜句长sd {r['ssd']:.1f}｜均段长 {r['pmean']:.1f}"
                f"｜对白段 {r['dlg_pct']:.0f}%｜环境段 {r['env2_pct']:.0f}%"
                f"｜说族 {r['said_kilo']:.1f}｜明喻 {r['simile_kilo']:.1f}"
                f"｜承接词 {r['conn_kilo']:.1f}")
    except Exception as e:
        return f'（上一章指标计算失败：{e}）'


def _split_cells(ln):
    return [c.strip() for c in ln.strip().strip('|').split('|')]


def plan_slim(path, max_rows=48):
    """V0.41：规划表只带关键列（编号｜功能·字数｜内容要点），压成逐段短行。

    段落要点是写手动笔逐段的最短地图；超出 max_rows 的段截尾并注明。
    解析失败返回 ''（调用方忽略并提示）。
    """
    t = read(path)
    if not t:
        return ''
    lines = t.split('\n')
    # 1) 表头前的关键注记（目标字数/段数/首句/语域），最多 4 条
    meta = []
    for ln in lines:
        if ln.lstrip().startswith('|'):
            break
        s = ln.strip().lstrip('>').strip()
        if any(k in s for k in ('目标字数', '段数', '首句', '语域')):
            meta.append('- ' + re.sub(r'\s+', '', s))
            if len(meta) >= 4:
                break
    # 2) 找表头行（含 编号/功能/字数/内容 任一字样）
    header = None
    start = None
    for i, ln in enumerate(lines):
        s = ln.strip()
        if not s.startswith('|'):
            continue
        cells = _split_cells(ln)
        if len(cells) < 3:
            continue
        if any(any(k in c for k in ('编号', '功能', '字数', '内容', '要点', '状态'))
               for c in cells):
            header = cells
            start = i + 1
            break
    if header is None:
        return ''
    # 列索引：编号 / 功能 / 字数 / 内容要点
    def idx(*keys):
        for k in keys:
            for j, c in enumerate(header):
                if k in c:
                    return j
        return None
    i_no, i_fn = idx('编号'), idx('功能')
    i_wc = idx('字数') if any('字数' in c for c in header) else None
    i_body = idx('内容', '要点', '状态')
    out = []
    for ln in lines[start:]:
        s = ln.strip()
        if not s.startswith('|'):
            continue
        cells = _split_cells(ln)
        if len(cells) >= 3 and all(re.fullmatch(r':?-{2,}:?', c or '-') for c in cells[1:]):
            continue  # 分隔行
        if i_no is not None and i_no < len(cells):
            no = cells[i_no].replace('**', '').strip()
        else:
            no = ''
        if not no and not any(c.strip() for c in cells):
            continue
        fn = cells[i_fn].replace('**', '').strip() if i_fn is not None and i_fn < len(cells) else ''
        wc = cells[i_wc].replace('**', '').strip() if i_wc is not None and i_wc < len(cells) else ''
        body = cells[i_body].replace('**', '').strip() if i_body is not None and i_body < len(cells) else ''
        flag = ''
        if any(w in fn for w in ('崩口', '蓄势', '断点', '爽点')):
            flag = '※'
        elif any(w in no for w in ('崩口', '蓄势')):
            flag = '※'
        head = '%s%s' % (flag, no)
        if fn:
            head += '·%s' % fn
        if wc:
            head += '·%s字' % wc
        if not body:
            body = '｜'.join(cells[max(1, i_body or 1):])[:60]
        out.append('- %s｜%s' % (head, body))
        if len(out) >= max_rows:
            out.append('- ……（规划表超过 %d 段，已截尾；完整版见规划表文件）' % max_rows)
            break
    head = '\n'.join(meta)
    return (head + '\n\n' if meta else '') + '\n'.join(out)


def build_full(args, n, tabs, confirmed):
    """原 11 板块全量组装（病灶 Top10＋最近10 / 语域卡 / 写作层目标 W1~W11 等），
    末尾追加 十二、题材档写作指令（V0.41 新资产，全量也带）。"""
    def on(key):
        return True if not confirmed else (key in confirmed)

    out = [f'# 第{n}章 注入包（全量 V0.41 · build_context.py）', '',
           f'> 题材档：**{args.genre}**｜模式：全量（原 11 板块）｜日常写章用默认精简更省 token'
           f'（人确认类目：{("、".join(sorted(confirmed)) if confirmed else "无，按题材档全量自动注入")}）',
           '> 生成器只需读本文件。**不要凭记忆拼注入物。**', '', '---', '']

    b = beat_row(tabs, n)
    if b:
        out += ['## 一、本章 beat（来自章节细纲表）', '', b, '']

    if args.plan and os.path.exists(args.plan):
        out += ['## 二、本章规划表', '', read(args.plan).strip(), '']

    if on('语域卡'):
        gc = genre_card(args.genre)
        if gc:
            out += ['## 三、语域卡（按题材档）', '', gc, '']

    if on('基线目标'):
        bl = baseline_for(args.genre, args.chapter_baseline)
        if bl:
            out += ['## 四、真人基线目标值（章级实测·垂直领域）', '', bl, '']
        wt = writing_targets(args.genre, args.chapter_baseline, args.ppl_baseline)
        if wt:
            out += ['## 四之二、写作层目标（W1~W7，把七维度缺口翻成指令）', '', wt, '']

    if on('语癖卡') and tabs:
        vc = voice_cards(tabs)
        if vc:
            out += ['## 五、人物语癖卡（门14 对表基准）', '', vc, '']

    if on('账本') and tabs:
        ls = ledger_state(tabs, n)
        if ls:
            out += ['## 六、账本状态（≤本章）', '', ls, '']

    if on('配额余额') and args.chapters_dir:
        files = sorted(glob.glob(os.path.join(args.chapters_dir, '*.md')))
        qb = quota_balance(files, n)
        if qb:
            out += ['## 七、配额余额（间隔制）', '', qb, '']
        pm = prev_metrics(files, n)
        if pm:
            out += ['## 八、上一章实测指标（章间锚定用）', '', pm, '']

    if args.disease and on('病灶库'):
        out += ['## 九、病灶库（频率Top10 ＋ 最近10条）', '',
                '> 指令：以下是此前被抓到的 AI 痕迹，本章**不得复现**。', '']
        t10 = disease_top10()
        if t10:
            out += ['### 9.1 频率 Top10', '', t10, '']
        rec = disease_recent(10)
        if rec:
            out += ['### 9.2 最近 10 条', '']
            for title, body in rec:
                out += [f'**{title}**', '', body[:400], '']

    bl2 = blacklist()
    if bl2:
        out += ['## 十、黑名单（规则书第四节）', '', bl2, '']

    if args.terms and os.path.exists(args.terms):
        out += ['## 十一、术语表', '', '```', read(args.terms).strip(), '```', '']

    # V0.41：题材档注入指令 + 中文腔铁禁（全量也带，保证 --full ⊇ 精简）
    inj = injection_instructions(args.genre, missing_note=True)
    if inj:
        out += ['## 十二、题材档写作指令（注入指令节，动笔前先读）', '',
                '> 取自 11_skills包/文风靶板_分题材/（按 --genre 自动选档）。'
                '动笔某类段落前先读对应模板层再落笔，写完全章跑一次自查。', '', inj, '']
    bwl = banword_line()
    if bwl:
        out += ['### 12.1 中文腔禁词铁禁（一行 regex）', '', bwl, '']
    return out


def build_slim(args, n, tabs, confirmed):
    """V0.41 默认精简：只拼写手必需 8 类，目标 ≤3,500 字。"""
    def on(key):
        return True if not confirmed else (key in confirmed)

    out = [f'# 第{n}章 注入包（精简 V0.41 · build_context.py）', '',
           f'> 题材档：**{args.genre}**｜模式：精简（写手必需 8 类；需要全量加 --full）',
           '> 只读本文件写章。**不要凭记忆拼注入物。**', '', '---', '']

    # 一、本章 beat（细纲表该章一行）
    b = beat_row(tabs, n)
    if b:
        out += ['## 一、本章 beat（章节细纲表该章行）', '', b, '']
    else:
        out += ['## 一、本章 beat', '', '（章节细纲表无第 %d 章行——写前先回填细纲表）' % n, '']

    # 二、本章规划表（--plan 时只带关键列）
    if args.plan and os.path.exists(args.plan):
        ps = plan_slim(args.plan)
        if ps:
            out += ['## 二、本章规划表（关键列压缩版）', '', ps, '']
        else:
            out += ['## 二、本章规划表', '',
                    '（无法压缩解析，原文较长——直接读：%s）' % args.plan, '']

    # 三、人物语癖卡（只列本章已出场角色）
    if on('语癖卡') and tabs:
        vc = voice_cards_slim(tabs, n)
        if vc:
            out += ['## 三、人物语癖卡（只列已出场角色）', '', vc, '']

    # 四、账本状态（与本章相关行）
    if on('账本') and tabs:
        ls = ledger_state_slim(tabs, n)
        if ls:
            out += ['## 四、账本状态（与本章相关行）', '', ls, '']
        else:
            out += ['## 四、账本状态（与本章相关行）', '', '（道具/事件/已知信息表暂无 ≤ 本章的行——写前先回填账本）', '']

    # 五、真人基线目标值（章级档 12 关键指标）
    if on('基线目标'):
        bl = baseline_slim(args.genre, args.chapter_baseline)
        if bl:
            out += ['## 五、真人基线目标值（章级档·12 项关键）', '', bl, '']

    # 六、病灶库 Top5
    if args.disease and on('病灶库'):
        d5 = disease_top5()
        if d5:
            out += ['## 六、病灶库 Top5（本章不得复现）', '',
                    '> 指令：以下是此前被抓到**频率最高**的 5 类 AI 痕迹，本章**不得复现**；'
                    '完整 Top10＋最近案例见 --full 注入包。', '', d5, '']

    # 七、黑名单（一行关键词）
    bl1 = blacklist_one_line()
    if bl1:
        out += ['## 七、黑名单速查（一行）', '', bl1, '']

    # 八、题材档最小范本集 + 注入指令 + 禁词铁禁
    inj = injection_instructions(args.genre, slim=True, missing_note=True)
    if inj:
        tf = target_file(args.genre)
        fname = os.path.basename(tf) if tf else '（未匹配）'
        out += ['## 八、题材档最小范本集与写作指令', '',
                '> 取自 文风靶板_分题材/%s（按 --genre 自动选档）。'
                '**先读范本（真人原句，知道"长什么样"），再读指令（知道"怎么做"）**；'
                '写完全章跑一次自查。' % fname, '', inj, '']
    bwl = banword_line()
    if bwl:
        if inj:
            out += ['### 8.1 中文腔禁词铁禁（一行 regex，命中叙述/对白层一律改）', '', bwl, '']
        else:
            out += ['## 八、题材档写作指令与禁词铁禁', '', bwl, '']
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapter', required=True, help='章号，如 第03章 或 3')
    ap.add_argument('--tables', default=None)
    ap.add_argument('--plan', default=None, help='本章规划表 md（精简模式只带关键列）')
    ap.add_argument('--beats', default=None, help='beat 文件（可选，细纲表已含）')
    ap.add_argument('--terms', default=None, help='术语表')
    ap.add_argument('--genre', default='西幻/异世界', help='题材档（垂直领域）')
    ap.add_argument('--baseline', default=os.path.join(HERE, '..', '08_统计基线', '题材基线_133本.json'))
    ap.add_argument('--chapter-baseline',
                    default=os.path.join(HERE, '..', '08_统计基线', '题材基线_章级_133本.json'),
                    help='章级基线（门7/写作目标用；同长度对照）')
    ap.add_argument('--ppl-baseline',
                    default=os.path.join(HERE, '..', '08_统计基线', 'ppl_分题材_133本.json'),
                    help='分题材困惑度基线')
    ap.add_argument('--chapters-dir', default=None, help='已写章节目录（算配额余额/上一章指标）')
    ap.add_argument('--confirm', default=None,
                    help='人确认的注入类目（逗号分隔）；未确认的按题材档自动注入')
    ap.add_argument('--no-disease', action='store_false', dest='disease',
                    help='关闭病灶库注入（默认注入）')
    ap.add_argument('--slim', action='store_true', help='精简模式（默认即精简，可省略）')
    ap.add_argument('--full', action='store_true', help='全量模式：恢复原 11 板块（病灶 Top10＋最近10 等）')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    if args.full and args.slim:
        print('--full 与 --slim 互斥，请二选一', file=sys.stderr)
        return 2
    mode = 'full' if args.full else 'slim'

    n = (chap_num(args.chapter) or [None])[0]
    if not n:
        print('无法解析章号', file=sys.stderr)
        return 1
    tabs = load_tables(args.tables) if args.tables and os.path.exists(args.tables) else {}
    confirmed = set(x.strip() for x in (args.confirm or '').split(',') if x.strip())

    out = build_full(args, n, tabs, confirmed) if mode == 'full' \
        else build_slim(args, n, tabs, confirmed)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    body = '\n'.join(out)
    io.open(args.out, 'w', encoding='utf-8').write(body)
    chars = len(re.sub(r'\s', '', body))
    tag = '全量' if mode == 'full' else '精简'
    print(f'已生成 {args.out}（{tag} {chars} 字，{len(out)} 行）')
    if mode == 'slim' and chars > SLIM_TARGET:
        print(f'⚠️ 精简包 {chars} 字 > {SLIM_TARGET} 目标——检查是否传了 --plan/--terms 等大件，'
              f'或题材档注入指令节偏长；仍可加 --full 得到完整口径。', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())

