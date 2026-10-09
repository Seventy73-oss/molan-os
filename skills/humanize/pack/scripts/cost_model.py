# -*- coding: utf-8 -*-
"""十万字成本测算 · 第二步：token 量与费用模型

数据来源（全部实测或官方页，见 00_十万字成本测算.md 末尾链接）：
  · 字符/token 比：本目录 token_ratio.py 用本地 Qwen2.5 分词器实测
  · 价格：DeepSeek 官方定价页（人民币）、Z.AI 官方定价页（美元）

口径约定：
  · "10 万字" = 10 万个**非空白字符**（含标点，网文平台常见口径）
  · 正文 token 比取实测 749.5 token/千字符；结构件（规划表/注入包）取 900~950 token/千字符
  · 章节规模：单章 2,500~4,500 字（规则书 V0.34 硬规则），实测 3,000~3,600，取 3,300 字/章 → 30 章
"""
import sys

sys.stdout.reconfigure(encoding='utf-8')

# ── 实测常量 ──────────────────────────────────────────────────────────
TOK_PER_KCHAR_BODY = 749.5      # 正文：我们 4 章实测均值
TOK_PER_KCHAR_DOC = 900.0       # 结构化文档（规划表 943 / 注入包 900 / 锚点卡 951）
TARGET_CHARS = 100_000          # 10 万字
CHARS_PER_CHAPTER = 3_300       # 单章目标字数
CHAPTERS = round(TARGET_CHARS / CHARS_PER_CHAPTER)   # 30 章

body_tokens_total = TARGET_CHARS / 1000 * TOK_PER_KCHAR_BODY
per_chapter_body = CHARS_PER_CHAPTER / 1000 * TOK_PER_KCHAR_BODY

# ── 每章各环节（现行五段流水线）────────────────────────────────────────
# 结构件字数取第 4 章实测：规划表 3,927 字符 / 注入包 7,508 字符 / 锚点卡 1,353 字符
PLAN_CHARS = 3_927
CTX_CHARS = 7_508
ANCHOR_CHARS = 1_353
EDIT_PACK_CHARS = 3_000        # 恶人编辑审核包（估算）

def tok(chars):
    return chars / 1000 * TOK_PER_KCHAR_DOC

# 情景 A：裸写（只有正文输出）
A_out = body_tokens_total
A_in = 0

# 情景 B：标准流水线（规划表 → 正文 → 恶人编辑，不含整合返工）
B_out = CHAPTERS * (tok(PLAN_CHARS) + per_chapter_body + 1_800)   # 1,800 = 恶人编辑报告输出
B_in = CHAPTERS * (tok(CTX_CHARS) + tok(ANCHOR_CHARS))

# 情景 C：含整合与返工（每章 1.5 次定向重写 + 一次整合修订）
Rework = 1.5
C_out = CHAPTERS * (tok(PLAN_CHARS) + per_chapter_body * (1 + Rework + 1) + 1_800)
C_in = CHAPTERS * (tok(CTX_CHARS) + tok(ANCHOR_CHARS) + 4_000 + 6_000)

# 开书一次性（主题/世界观/卷纲/章纲/设定表）
KICKOFF_IN, KICKOFF_OUT = 25_000, 35_000

scenarios = [
    ('A 裸写（只出正文）', A_in, A_out),
    ('B 标准流水线（规划表+正文+恶人编辑）', B_in + KICKOFF_IN, B_out + KICKOFF_OUT),
    ('C 含整合与返工（1.5 次重写/章）', C_in + KICKOFF_IN, C_out + KICKOFF_OUT),
]

print('=' * 78)
print('十万字网文 · token 与费用测算')
print('=' * 78)
print('口径：10 万字 = 100,000 非空白字符（含标点）；正文 %.1f token/千字符（实测）'
      % TOK_PER_KCHAR_BODY)
print('      单章 %d 字 → %d 章；正文本身 ≈ %s token'
      % (CHARS_PER_CHAPTER, CHAPTERS, format(round(body_tokens_total), ',')))
print()
print('%-38s %14s %14s %14s' % ('情景', '输入 token', '输出 token', '合计 token'))
print('-' * 78)
for name, ti, to in scenarios:
    print('%-38s %14s %14s %14s' % (
        name, format(round(ti), ','), format(round(to), ','), format(round(ti + to), ',')))

# ── 价格表 ────────────────────────────────────────────────────────────
# (模型, 输入未命中, 输入命中缓存, 输出, 币种)
PRICES = [
    ('DeepSeek V4-Flash（高峰）', 3.0, 0.10, 9.0, 'CNY'),
    ('DeepSeek V4-Flash（空闲）', 1.5, 0.05, 4.5, 'CNY'),
    ('DeepSeek V4-Pro（高峰）', 9.0, 0.30, 27.0, 'CNY'),
    ('GLM-5.3-Flash（限时5折）', 0.15 * 7.1, 0.075 * 7.1, 0.50 * 7.1, 'CNY'),
    ('GLM-4.7 / 4.6 / 4.5', 0.60 * 7.1, 0.11 * 7.1, 2.20 * 7.1, 'CNY'),
    ('GLM-5.3', 1.40 * 7.1, 0.26 * 7.1, 4.40 * 7.1, 'CNY'),
    ('GLM-4.5-Flash / 4.7-Flash', 0.0, 0.0, 0.0, 'CNY'),
]

print()
print('=' * 78)
print('费用（人民币元；美元按 1 USD ≈ 7.1 CNY 折算）')
print('=' * 78)
print('%-26s %14s %14s %14s' % ('模型', 'A 裸写', 'B 标准流水线', 'C 含返工'))
print('-' * 78)
for name, pin, pcache, pout, cur in PRICES:
    cells = []
    for _, ti, to in scenarios:
        cost = ti / 1e6 * pin + to / 1e6 * pout
        cells.append('%.2f' % cost)
    print('%-26s %14s %14s %14s' % (name, cells[0], cells[1], cells[2]))

print()
print('=' * 78)
print('缓存命中情形（DeepSeek V4-Flash 高峰；输入全部命中缓存）')
print('=' * 78)
for name, ti, to in scenarios:
    cost = ti / 1e6 * 0.10 + to / 1e6 * 9.0
    cost_free = to / 1e6 * 9.0
    print('%-38s 命中后 %.2f 元（若不命中 %.2f 元）' % (
        name, cost, ti / 1e6 * 3.0 + to / 1e6 * 9.0))

print()
print('=' * 78)
print('每章平均（情景 C）')
print('=' * 78)
ti_c, to_c = scenarios[2][1], scenarios[2][2]
print('  输入 %s token / 输出 %s token / 合计 %s token'
      % (format(round(ti_c / CHAPTERS), ','), format(round(to_c / CHAPTERS), ','),
         format(round((ti_c + to_c) / CHAPTERS), ',')))
print('  其中正文输出 %s token（占输出 %.0f%%）'
      % (format(round(per_chapter_body), ','), 100 * per_chapter_body / (to_c / CHAPTERS)))
