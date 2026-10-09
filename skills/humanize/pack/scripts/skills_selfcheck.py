# -*- coding: utf-8 -*-
"""skills 包全量体检（作者 2026-09-10 要求"从头到尾把整个 skills 检查一遍"）

六项检查：
  ① 必需文件完整性（规则书/7 门族入口/基线/模板/数据件）
  ② 每个脚本可执行（`--help` 退出码）
  ③ 阈值一致性（规则书文字 vs 脚本默认值，防"规则写了但脚本没改"）
  ④ 12 张表名一致性（模板 ↔ 各门读取的表名）
  ⑤ 回归测试（坏稿必命中/好稿必放行/豁免生效）
  ⑥ 技能包同步（skills_V0.3 与项目文件 md5 对比）

用法：python 03_评分与校准/skills_selfcheck.py
退出码：0 全通过；2 有失败项。
"""
import glob
import hashlib
import io
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
PY = sys.executable or 'python'
FAILS, WARNS, OKS = [], [], []


def ok(msg):
    OKS.append(msg)
    print('  [OK  ] ' + msg)


def fail(msg):
    FAILS.append(msg)
    print('  [FAIL] ' + msg)


def warn(msg):
    WARNS.append(msg)
    print('  [WARN] ' + msg)


def md5(p):
    return hashlib.md5(io.open(p, 'rb').read()).hexdigest()


print('=' * 78)
print('skills 包全量体检')
print('=' * 78)

# ── ① 必需文件 ──────────────────────────────────────────────────────
print('\n[1] 必需文件完整性')
rules = sorted(glob.glob(os.path.join(ROOT, '11_skills包', '规则书_V*.md')))
live = [r for r in rules if 'superseded' not in r]
if len(live) == 1:
    ok('规则书唯一现行版：%s（归档 %d 份）' % (os.path.basename(live[0]), len(rules) - 1))
else:
    fail('现行规则书不是唯一：%s' % [os.path.basename(x) for x in live])

GATES = ['ai_flavor_score.py', 'tail_check.py', 'lint_check.py', 'repeat_check.py',
         'ledger_check.py', 'process_check.py', 'dist_check.py']
for g in GATES:
    if os.path.exists(os.path.join(HERE, g)):
        ok('门族入口存在：' + g)
    else:
        fail('门族入口缺失：' + g)

BASELINES = ['题材基线_133本.json', '题材基线_章级_133本.json', '题材标签_133本.json',
             'ppl_真人133本.json', 'ppl_分题材_133本.json', '承接词词表_133本.json']
# 2026-09-11：兼容两种布局——主工程用 08_统计基线/，技能包用 data/（此前包内自检必然 FAIL 6 项）
BASE_DIRS = [os.path.join(ROOT, '08_统计基线'), os.path.join(ROOT, 'data')]
for b in BASELINES:
    p = next((os.path.join(d, b) for d in BASE_DIRS if os.path.exists(os.path.join(d, b))), None)
    if p:
        ok('基线存在：%s（%s）' % (b, os.path.basename(os.path.dirname(p))))
    else:
        fail('基线缺失：%s' % b)

# 2026-09-11：同样兼容两种布局——主工程 13_设定表/，技能包 templates/
TPL_CANDIDATES = [os.path.join(ROOT, '13_设定表', '设定表_模板.xlsx'),
                  os.path.join(ROOT, 'templates', '设定表_模板.xlsx')]
tpl = next((p for p in TPL_CANDIDATES if os.path.exists(p)), TPL_CANDIDATES[0])
if os.path.exists(tpl):
    ok('设定表模板存在')
else:
    fail('设定表模板缺失')

# ── ② 脚本可执行 ────────────────────────────────────────────────────
print('\n[2] 脚本可执行性（语法编译 + 有 argparse 的跑 --help）')
scripts = sorted(glob.glob(os.path.join(HERE, '*.py')))
bad = []
checked = 0
for s in scripts:
    base = os.path.basename(s)
    if base.startswith('_') or base == 'skills_selfcheck.py':
        continue                      # 下划线开头是库；自身跳过（否则递归超时）
    checked += 1
    try:
        p = subprocess.run([PY, '-m', 'py_compile', s], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=60)
        if p.returncode != 0:
            bad.append('%s(语法错误)' % base)
            continue
    except Exception as e:
        bad.append('%s(%s)' % (base, type(e).__name__))
        continue
    txt = io.open(s, encoding='utf-8').read()
    if 'argparse' not in txt:
        continue                      # 无 CLI 的脚本（如评分器直接吃文件参数），跳过 --help
    try:
        p = subprocess.run([PY, s, '--help'], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=90)
        if p.returncode != 0:
            bad.append('%s(--help 退出 %d)' % (base, p.returncode))
    except Exception as e:
        bad.append('%s(--help %s)' % (base, type(e).__name__))
if bad:
    fail('脚本检查失败：%s' % '、'.join(bad))
else:
    ok('全部 %d 个脚本语法通过；带 argparse 的 --help 正常' % checked)

# ── ③ 阈值一致性 ────────────────────────────────────────────────────
print('\n[3] 阈值一致性（规则书 vs 脚本默认值）')
rule_txt = io.open(live[0], encoding='utf-8').read()
src = {}
for f in GATES + ['run_gates.py']:
    p = os.path.join(HERE, f)
    src[f] = io.open(p, encoding='utf-8').read() if os.path.exists(p) else ''
checks = [
    ('门1 语感 37', '37', 'run_gates.py', r"--flavor-max', type=float, default=37"),
    ('门1 内部通过线 46', '46', 'ai_flavor_score.py', r'def score_text\(text, threshold=46\)'),
    ('门3 说族逐章 0.46', '0.46', 'lint_check.py', r"said_max_ch'\),?|default=0\.46"),
    ('门3 说族整合 0.52', '0.52', 'lint_check.py', r"default=0\.52"),
    ('门3 术语 13.8', '13.8', 'lint_check.py', r"default=13\.8"),
    ('门2 ≤30字段落 0.92', '0.92', 'tail_check.py', r"default=0\.92"),
    ('门2 后半落差 0.17', '0.17', 'tail_check.py', r"default=0\.17"),
    ('门2 >100字占比 0.35', '0.35', 'tail_check.py', r"default=0\.35"),
    ('门7 上限系数 1.15', '1.15', 'dist_check.py', r'UPPER_SLACK = 1\.15'),
    ('标点下限 2.3', '2.3', 'lint_check.py', r"'？': 2\.3"),
    ('标点下限 1.5', '1.5', 'lint_check.py', r"'！': 1\.5"),
    ('标点下限 0.4', '0.4', 'lint_check.py', r"'……': 0\.4"),
    ('标点下限 0.7', '0.7', 'lint_check.py', r"'、': 0\.7"),
]
for label, num, script, pat in checks:
    in_rule = num in rule_txt
    in_src = bool(re.search(pat, src.get(script, '')))
    if in_rule and in_src:
        ok('%s（规则书✓ 脚本✓）' % label)
    elif in_src and not in_rule:
        warn('%s：脚本有、规则书未写明' % label)
    elif in_rule and not in_src:
        fail('%s：规则书写了、脚本未实现' % label)
    else:
        fail('%s：两边都没有' % label)

# ── ④ 12 张表名一致性 ───────────────────────────────────────────────
print('\n[4] 12 张表名一致性')
from openpyxl import load_workbook  # noqa: E402
wb = load_workbook(tpl)
sheets = [s for s in wb.sheetnames if s != '填写说明']
expect = ['主题定位表', '主角设定表', '配角设定表', '世界观速查表', '卷总纲表', '万字节点表',
          '章节细纲表', '伏笔钩子台账', '节奏查询表', '事件时间表', '人物已知信息表', '道具表']
missing = [e for e in expect if e not in sheets]
if missing:
    fail('模板缺表：%s' % '、'.join(missing))
else:
    ok('模板含全部 12 张表')
used = set()
for f in ['ledger_check.py', 'rhythm_check.py', 'table_sync_check.py', 'voice_table_check.py',
          'consistency_check.py', 'plan_check.py', 'process_check.py', 'build_context.py']:
    t = src.get(f) or (io.open(os.path.join(HERE, f), encoding='utf-8').read()
                       if os.path.exists(os.path.join(HERE, f)) else '')
    for m in re.findall(r"['\"]([\u4e00-\u9fff]{3,8}表|伏笔钩子台账|事件时间表|人物已知信息表|节奏查询表)['\"]", t):
        used.add(m)
unknown = sorted(u for u in used if u not in expect)
if unknown:
    warn('脚本引用了模板里没有的表名：%s' % '、'.join(unknown))
else:
    ok('脚本引用的表名全部在模板中（共 %d 个）' % len(used))

# ── ⑤ 回归测试 ──────────────────────────────────────────────────────
print('\n[5] 回归测试')
p = subprocess.run([PY, os.path.join(HERE, '回归测试', 'run_regression.py')],
                   capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=900)
tail = (p.stdout or '').strip().splitlines()[-1] if (p.stdout or '').strip() else ''
if p.returncode == 0:
    ok('回归通过：' + tail)
else:
    fail('回归失败：' + tail)

# ── ⑥ 技能包同步 ────────────────────────────────────────────────────
print('\n[6] 技能包同步（skills_V0.3）')
SK = os.path.join(ROOT, 'skills_V0.3')
if not os.path.isdir(SK):
    warn('skills_V0.3 不存在')
else:
    pairs = [('11_skills包/规则书_%s' % os.path.basename(live[0]).replace('规则书_', ''),
              'references/01_%s' % os.path.basename(live[0]))]
    for g in GATES + ['_metrics.py', 'build_context.py', 'run_gates.py', 'narrative_probe.py',
                      'style_metrics.py', 'build_chapter_baseline.py', 'conn_words.py',
                      'ppl_genre_baseline.py', 'style_anchor.py', 'lexical_style_probe.py',
                      'punct_stats.py']:
        pairs.append(('03_评分与校准/' + g, 'scripts/' + g))
    stale = []
    for src_rel, dst_rel in pairs:
        a = os.path.join(ROOT, src_rel)
        b = os.path.join(SK, dst_rel)
        if not os.path.exists(b):
            stale.append('缺 ' + dst_rel)
        elif os.path.exists(a) and md5(a) != md5(b):
            stale.append('不同步 ' + dst_rel)
    if stale:
        fail('技能包与项目不一致 %d 项：%s' % (len(stale), '；'.join(stale[:6])))
    else:
        ok('技能包与项目一致（%d 个文件）' % len(pairs))

# ── 汇总 ────────────────────────────────────────────────────────────
print('\n' + '=' * 78)
print('体检结果：OK %d ｜ 报警 %d ｜ 失败 %d' % (len(OKS), len(WARNS), len(FAILS)))
if WARNS:
    print('报警：')
    for w in WARNS:
        print('  - ' + w)
if FAILS:
    print('失败：')
    for f in FAILS:
        print('  - ' + f)
    sys.exit(2)
print('全部通过。')
