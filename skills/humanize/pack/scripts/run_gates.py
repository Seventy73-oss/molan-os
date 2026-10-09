# -*- coding: utf-8 -*-
"""run_gates.py — 五道机器门一键复跑（规则书 V0.33 起；V0.41 输出收敛）

为什么是 Python 而不是 .ps1：Windows PowerShell 5.1 读无 BOM 的 .ps1 按 GBK 解码，
脚本里的中文/箭头字符会把字符串引号吃掉导致 ParserError（实测）。门本身都是 Python，
用 Python 编排，编码由自己掌控。

用法：
  python run_gates.py --chapters "..\\15_新书_骨语者\\chapters" --terms "..\\15_新书_骨语者\\术语表_骨语者.txt"
  python run_gates.py --chapters ... --quota ... --flavor-max 32 --out gate_report.txt

退出码：0 全绿；2 有打回项。

V0.41（输出收敛，2026-09-10 · 见 17_修复方案/03_门判据精简提案.md 第六节）：
  · **默认收敛输出（--quiet）**：头部＋每门族一行摘要（门名＋OK/打回/跳过）＋打回族全量明细
    ＋报警/豁免命中明细＋字数硬规则一行＋门覆盖率自检一行＋打回清单。
    删除的噪音：逐章 [OK] 明细、长段落点清单、判据逐项展开、verbatim/beat/plan 等
    [N/A]/[未执行] 固定占位（beat、--plan 缺省改为在门摘要里一行标注）。
  · **--verbose 或 --full-report**：恢复 V0.40 及更早的全量明细输出（逐字节等价，不含摘要行）。
  · **判定行为不变**：quiet 只影响"打印什么"，不影响"判什么"——exit code、打回清单内容、
    报警项内容与改造前完全一致；子进程照常执行，打回族（exit!=0）全量打印绝不截断。
  · 收敛模式下向 dist_check.py 传 --quiet（该脚本已支持：不打印 15 行指标表/偏边记录）。
  · 全量明细如需落盘留档：用 --verbose --out …（quiet 下 --out 写的是收敛版报告）。
"""
import argparse
import glob
import os
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable or 'python'


def run(cmd):
    """跑一个门，返回 (exitcode, 合并输出)。"""
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def default_quota():
    """配额账本位置随目录结构变化（原工程在 11_skills包/，技能包在 data/）。"""
    cands = [
        os.path.join(HERE, '..', '11_skills包', '配额账本.json'),
        os.path.join(HERE, '..', 'data', '配额账本.json'),
        os.path.join(HERE, '配额账本.json'),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return cands[0]


# V0.41：quiet 模式下从子进程输出里挑出的"必看行"标记。
# 打回/报警/豁免命中一律完整打印；其余 OK 明细、表格、[N/A]、[跳过项] 等噪音一律折叠。
# '豁免' 单独作标记太宽（会误留 quota 的"章尾钩子豁免"提示行），故用具体形态：
KEEP_MARKS = ('[报警', '[豁免', '[E项豁免', '豁免命中', '豁免（自动发现）', '豁免：',
              '⚠', '✗', '越界', '漂移')


def _is_detail(s):
    """报警/豁免块内明细行的形态：缩进 +（· / ⚠ / ✗）。"""
    return s.startswith(('·', '⚠', '✗'))


def quiet_keep(out_lines):
    """quiet 收敛：返回子进程输出中需要打印的行（报警/豁免/打回块＋其明细行）。

    规则：
      · 行内含 KEEP_MARKS 任一项 → 保留，其后以（·/⚠/✗）开头的明细行随行保留；
      · 块头行（[报警项]/[豁免]）若其下一非空行是"无"（占位）→ 整块折叠；
      · 其余全部折叠（[OK] 逐章明细、观察组、[跳过项]、verbatim [N/A]、表格、横幅等）。
    """
    keep, i, n = [], 0, len(out_lines)
    while i < n:
        ln = out_lines[i]
        s = ln.strip()
        i += 1
        if not s:
            continue
        if not any(m in ln for m in KEEP_MARKS):
            continue
        if s.startswith(('[报警项]', '[豁免]')):
            # 内容仅为"无"的占位块 → 折叠（有报警/豁免时明细行随块保留）
            j = i
            while j < n and not out_lines[j].strip():
                j += 1
            if j < n and out_lines[j].strip() in ('无', '无。'):
                i = j + 1
                continue
            keep.append(ln)
            while i < n and _is_detail(out_lines[i].strip()):
                keep.append(out_lines[i])
                i += 1
            continue
        keep.append(ln)          # 内容行自带全部信息（[报警] 汇总 / ⚠ / 豁免命中…）
        while i < n and _is_detail(out_lines[i].strip()):
            keep.append(out_lines[i])
            i += 1
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True, help='章节目录（*.md）')
    ap.add_argument('--quota', default=default_quota())
    ap.add_argument('--terms', default=None, help='术语表文件')
    ap.add_argument('--tables', default=None,
                    help='设定表工作簿（门12/13/14/16 的数据件；缺省自动查找 设定表_*.xlsx）')
    ap.add_argument('--plan', default=None, help='本章规划表 md（门15 规划表完整性）')
    ap.add_argument('--beats', default=None,
                    help='beat 文件（门2 落点核对）；未提供时自动从 --tables 的「章节细纲表」导出（V0.41.1 P3）')
    ap.add_argument('--waiver', default=None, help='受控瑕疵清单（门17）')
    ap.add_argument('--flavor-max', type=float, default=37.0, dest='flavor_max',
                    help='门1 语感分上限（V0.39：32×1.15=37；作者指示"上限调高 10~20%%"）')
    ap.add_argument('--genre', default='西幻/异世界', help='门7 题材档（垂直领域基线）')
    ap.add_argument('--chapter-baseline', dest='chapter_baseline', default=None,
                    help='门7 章级基线 JSON（默认 08_统计基线/题材基线_章级_133本.json）')
    ap.add_argument('--ppl-json', dest='ppl_json', default=None,
                    help='困惑度实测 JSON（style_metrics --out 产物）；给了才判 D16')
    ap.add_argument('--exempt', default=None, help='门7 豁免白名单 JSON')
    ap.add_argument('--min-chars', type=int, default=2500, dest='min_chars',
                    help='单章字数下限（默认 2500）')
    ap.add_argument('--max-chars', type=int, default=5175, dest='max_chars',
                    help='单章字数上限（V0.39：4500×1.15=5175；V0.41 起不设上限，保留参数兼容）')
    ap.add_argument('--short-chars', type=int, default=3000, dest='short_chars',
                    help='短章线（默认 3000；低于此值的章占比须 <= 40%%）')
    ap.add_argument('--out', default=None)
    ap.add_argument('--quiet', action='store_true',
                    help='收敛输出（V0.41 起默认开启；与 --verbose 同给时 --verbose 优先）')
    ap.add_argument('--verbose', action='store_true', dest='verbose',
                    help='全量明细输出（恢复 V0.40 及更早的逐行报告）')
    ap.add_argument('--full-report', action='store_true', dest='verbose',
                    help='同 --verbose：恢复改造前的全量报告')
    args = ap.parse_args()

    verbose = bool(args.verbose)          # --verbose / --full-report → 全量
    quiet = not verbose                   # 默认收敛（--quiet 显式给也收敛）

    files = sorted(glob.glob(os.path.join(args.chapters, '*.md')))
    if not files:
        print('no chapter files in ' + args.chapters, file=sys.stderr)
        return 1

    fails, log = [], []

    def say(s=''):
        """打印到 stdout 并进 log（--out 存的是 stdout 相同内容，收敛版）。"""
        print(s)
        log.append(s)

    sizes = []
    for f in files:
        t = open(f, encoding='utf-8').read()
        sizes.append((os.path.basename(f), len(re.sub(r'\s', '', t))))
    total = sum(n for _, n in sizes)

    # ── 头部 ──
    say('=' * 72)
    say(f'复跑 | 章数 {len(files)} | 正文合计 {total} 字 | 均 {round(total / len(files))} 字/章')
    say('生效门（7 个门族）：门1 语感｜门2 节奏｜门3 卫生｜门4 重复与配额｜门5 账本｜门6 流程｜门7 分布对齐。')
    if verbose:                       # 逐章字数明细只在全量报告里
        for b, n in sizes:
            say(f'   {b}  {n} 字')

    # ── 字数硬规则（作者裁定 V0.34 修订：只取前 10 章核算；不足 10 章不适用）
    #    V0.41（2026-09-10 作者裁定）：**不设单章字数上限**；只保留下限与短章占比。
    FIRST_N = 10
    if verbose:
        say(f'字数硬规则（作者 2026-09-10 裁定：**不设字数上限**）：'
            f'单章 ≥{args.min_chars}；<{args.short_chars} 的章 ≤ 前{FIRST_N}章数的 40%；'
            f'**不足 {FIRST_N} 章不适用本规则**')
    if len(files) < FIRST_N:
        if verbose:
            say(f'  [N/A] 已生成 {len(files)} 章 < {FIRST_N} 章 → 字数硬规则不适用（本次跳过，不构成打回）')
        else:
            say(f'[字数硬规则] [N/A] 已生成 {len(files)} 章 < {FIRST_N} 章 → 不适用（本次跳过，不构成打回）')
    else:
        scope = sizes[:FIRST_N]
        under = [b for b, n in scope if n < args.short_chars]
        pct = 100.0 * len(under) / len(scope)
        if verbose:
            say(f'  核算范围：前 {len(scope)} 章（{scope[0][0]} … {scope[-1][0]}）'
                f'  →  <{args.short_chars} 共 {len(under)} 章 = {round(pct, 1)}%')
        oob = [b for b, n in scope if n < args.min_chars]
        if oob:
            fails.append('字数低于下限(<%d)：' % args.min_chars + '、'.join(oob))
            if verbose:
                say(f'  [打回] 字数低于下限 {len(oob)} 章')
        elif verbose:
            say('  [OK] 前 10 章全部 ≥%d（上限不设）' % args.min_chars)
        if pct > 40:
            fails.append(f'<{args.short_chars}字章占比 {round(pct, 1)}% > 40%')
            if verbose:
                say('  [打回] <%d 章占比超 40%%' % args.short_chars)
        elif verbose:
            say(f'  [OK] <{args.short_chars} 章占比 {round(pct, 1)}% ≤ 40%')
        if not verbose:
            if oob or pct > 40:
                say(f'[字数硬规则] [打回] 见打回清单（<{args.min_chars} 章 '
                    f'{len(oob)} 个；<{args.short_chars} 章占比 {round(pct, 1)}%）')
            else:
                say(f'[字数硬规则] [OK] 前 {len(scope)} 章全部 ≥{args.min_chars}；'
                    f'<{args.short_chars} 章占比 {round(pct, 1)}% ≤ 40%')

    ran = set()

    # ── 门1（逐章，脚本一次只吃一个文件）──
    ran.add('门1')
    if verbose:
        say('\n===== 门1 ai_flavor_score.py（≤%g 分/章）=====' % args.flavor_max)
    gate1_fail, gate1_high, gate1_detail = [], 0, []
    for f in files:
        rc, out = run([PY, os.path.join(HERE, 'ai_flavor_score.py'), f])
        m = re.search(r'"score":\s*(\d+)', out)
        mc = re.search(r'"chars":\s*(\d+)', out)
        name = os.path.basename(f)
        if not m:
            say(f'  [错误] {name} 无法解析评分')
            fails.append(f'门1 解析失败：{name}')
            continue
        score = int(m.group(1))
        chars = mc.group(1) if mc else '?'
        gate1_high = max(gate1_high, score)
        if score > args.flavor_max:
            gate1_fail.append(f'{name} score={score}')
            detail = [f'  [打回] {name} score={score} chars={chars}']
            for line in out.splitlines():
                if re.search(r'violat|reason|pattern|msg', line):
                    detail.append('         ' + line.strip())
            if verbose:
                for d in detail:
                    say(d)
            else:
                gate1_detail.extend(detail)
            fails.append(f'门1 {name} score={score}')
        elif verbose:
            say(f'  [OK ] {name} score={score} chars={chars}')
    if not verbose:
        if gate1_fail:
            say(f'[门1] 语感：打回 {len(gate1_fail)} 章（score 超上限，明细见下）')
        else:
            say(f'[门1] 语感：OK｜{len(files)} 章，score 最高 {gate1_high}（上限 {args.flavor_max:g}）'
                f' ← P5 提醒：门1 全绿≠真人（朱雀实测给 0 分稿判 0.648），须送外部检测/人审')
        for d in gate1_detail:
            say(d)

    # ── 门2 ──
    # P3 修复（V0.41.1）：门2 的「崩口位/蓄势位落点核对」需要 beat 文件；
    #   未显式给 --beats 时，自动从 --tables 的「章节细纲表」导出（export_beats.py）。
    ran.add('门2')
    beats_path = args.beats
    if not beats_path and args.tables and os.path.exists(args.tables):
        auto_beats = os.path.join(os.path.dirname(os.path.abspath(args.tables)), '_auto_beats.md')
        try:
            _eb = os.path.join(HERE, 'export_beats.py')          # 技能包内：与脚本同目录
            if not os.path.exists(_eb):
                _eb = os.path.join(HERE, '..', '13_设定表', 'export_beats.py')  # 主工程
            subprocess.run([PY, _eb, args.tables, '--out', auto_beats],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.exists(auto_beats):
                beats_path = auto_beats
        except Exception:
            beats_path = None
    if verbose:
        say('\n===== 门2 tail_check.py =====')
    cmd2 = [PY, os.path.join(HERE, 'tail_check.py'), '--files'] + files
    if beats_path:
        cmd2 += ['--beats', beats_path]
    rc, out = run(cmd2)
    if not verbose:
        if rc:
            say(f'[门2] 节奏：打回（exit={rc}，明细见下）')
        elif beats_path:
            say('[门2] 节奏：OK（含 beat 落点核对：%s）' % os.path.basename(beats_path))
        else:
            say('[门2] 节奏：OK（未取到 beat → 只查数量，落点未核对）')
    for line in (out.rstrip().splitlines() if (verbose or rc) else quiet_keep(out.rstrip().splitlines())):
        say('  ' + line)
    if rc != 0:
        fails.append(f'门2 tail_check exit={rc}')

    # ── 门3 卫生 ──
    ran.add('门3')
    if verbose:
        say('\n===== 门3 lint_check.py（卫生：标点/说族占比/术语密度）=====')
    cmd = [PY, os.path.join(HERE, 'lint_check.py'), '--files'] + files
    if args.terms:
        cmd += ['--terms', args.terms]
    cmd += ['--punct-min']          # V0.39：标点多样性下限（只报警）
    rc, out = run(cmd)
    if not verbose:
        if rc:
            say(f'[门3] 卫生：打回（exit={rc}，明细见下）')
        else:
            say('[门3] 卫生：OK')
    for line in (out.rstrip().splitlines() if (verbose or rc) else quiet_keep(out.rstrip().splitlines())):
        say('  ' + line)
    if rc != 0:
        fails.append(f'门3 lint_check exit={rc}')

    # ── 门4 重复与配额（＝原门7a＋门7b，方案B 合并）──
    ran.add('门4')
    if verbose:
        say('\n===== 门4 repeat_check.py（重复与配额 ＝ 门7a＋门7b）=====')
    cmd = [PY, os.path.join(HERE, 'repeat_check.py'), '--files'] + files
    if args.tables:
        cmd += ['--tables', args.tables]
    if args.quota:
        cmd += ['--quota', args.quota]
    rc, out = run(cmd)
    if not verbose:
        if rc:
            say(f'[门4] 重复与配额：打回（exit={rc}，明细见下）')
        else:
            say('[门4] 重复与配额：OK')
    for line in (out.rstrip().splitlines() if (verbose or rc) else quiet_keep(out.rstrip().splitlines())):
        say('  ' + line)
    if rc != 0:
        fails.append(f'门4 repeat_check exit={rc}')

    # ── 门5 账本（＝原门13＋门12＋门14，方案B 合并）──
    ran.add('门5')
    if verbose:
        say('\n===== 门5 ledger_check.py（账本 ＝ 门13表同步＋门12事实＋门14语癖卡）=====')
    cmd = [PY, os.path.join(HERE, 'ledger_check.py'), '--chapters', args.chapters]
    if args.tables:
        cmd += ['--tables', args.tables]
    rc, out = run(cmd)
    if not verbose:
        if rc:
            say(f'[门5] 账本：打回（exit={rc}，明细见下）')
        else:
            say('[门5] 账本：OK')
    for line in (out.rstrip().splitlines() if (verbose or rc) else quiet_keep(out.rstrip().splitlines())):
        say('  ' + line)
    if rc != 0:
        fails.append(f'门5 ledger_check exit={rc}')

    # ── 门6 流程（＝原门15＋门16＋门17，方案B 合并）──
    ran.add('门6')
    if verbose:
        say('\n===== 门6 process_check.py（流程 ＝ 门15规划表＋门16节奏＋门17瑕疵）=====')
    cmd = [PY, os.path.join(HERE, 'process_check.py'), '--chapters', args.chapters]
    if args.tables:
        cmd += ['--tables', args.tables]
    if args.plan:
        cmd += ['--plan', args.plan]
    if args.waiver:
        cmd += ['--waiver', args.waiver]
    rc, out = run(cmd)
    if not verbose:
        if rc:
            say(f'[门6] 流程：打回（exit={rc}，明细见下）')
        elif not args.plan:
            say('[门6] 流程：OK（未传 --plan → 门15 规划表未执行）')
        else:
            say('[门6] 流程：OK')
    for line in (out.rstrip().splitlines() if (verbose or rc) else quiet_keep(out.rstrip().splitlines())):
        say('  ' + line)
    if rc != 0:
        fails.append(f'门6 process_check exit={rc}')
    if verbose:
        say('\n' + '=' * 72)

    # ── 门7 分布对齐（V0.38 新增：七维度攻坚）──
    ran.add('门7')
    if verbose:
        say('\n===== 门7 dist_check.py（分布对齐：上下限双向＋章间漂移＋困惑度）=====')
    cmd = [PY, os.path.join(HERE, 'dist_check.py'),
           '--chapters', os.path.join(args.chapters, '*.md'), '--genre', args.genre]
    if quiet:
        cmd += ['--quiet']          # V0.41：收敛模式让 dist 别打 15 行指标表
    if args.chapter_baseline:
        cmd += ['--baseline', args.chapter_baseline]
    if args.ppl_json:
        cmd += ['--ppl-json', args.ppl_json]
    if args.exempt:
        cmd += ['--exempt', args.exempt]
    rc, out = run(cmd)
    if not verbose:
        if rc == 3:
            say('[门7] 分布对齐：跳过（缺基线文件，先跑 build_chapter_baseline.py）')
        elif rc:
            say(f'[门7] 分布对齐：打回（exit={rc}，明细见下）')
        else:
            say('[门7] 分布对齐：OK')
    if verbose or rc != 0:
        for line in out.rstrip().splitlines():
            say('  ' + line)
    else:
        for line in quiet_keep(out.rstrip().splitlines()):
            say('  ' + line)
    if rc == 3:
        if verbose:
            say('  [SKIP] 门7 缺基线文件（先跑 build_chapter_baseline.py）')
    elif rc != 0:
        fails.append(f'门7 dist_check exit={rc}')

    # ── P1 修复（V0.41.1）：中文腔禁词扫描（**报警级，不阻断 exit code**）──
    #   作者 2026-09-10 点名"儿化/搁/费神/后头/白得白丢"等为严重中文腔；
    #   禁词表 v2 此前只活在注入包提示里，机器不查——现接入跑门作为报警项。
    #   适用范围（作者 2026-09-10 追加裁定）：**本清单为西幻/异世界语域专用**；
    #   武侠/仙侠/历史等档的**对话层不受限**（中文口语/古白话/方言可用），故非西幻档跳过。
    try:
        import json as _json
        _bw = os.path.join(HERE, '..', '11_skills包', '中文腔禁词清单_v2.json')
        _seg = (args.genre or '').split('/')[0]
        if _seg != '西幻':
            say('[报警] 中文腔禁词扫描：本档（%s）**跳过**——该清单为西幻/异世界语域专用；'
                '武侠/仙侠/历史等对话层不受限（按各自靶板红线）' % (args.genre or '未指定'))
        elif os.path.exists(_bw):
            _d = _json.load(open(_bw, encoding='utf-8'))
            _rx = _d.get('regex_铁禁') or ''
            _ex = _d.get('豁免') or []
            if _rx:
                _pat = re.compile(_rx)
                _hits = []
                for f in files:
                    _t = open(f, encoding='utf-8', errors='ignore').read()
                    for _w in _ex:
                        _t = _t.replace(_w, '')
                    _cnt = {}
                    for _m in _pat.finditer(_t):
                        _cnt[_m.group(0)] = _cnt.get(_m.group(0), 0) + 1
                    if _cnt:
                        _top = '、'.join('%s×%d' % (k, v) for k, v in
                                         sorted(_cnt.items(), key=lambda x: -x[1])[:8])
                        _hits.append('%s：%s' % (os.path.basename(f), _top))
                if _hits:
                    say('[报警] 中文腔禁词命中（作者 2026-09-10 点名，禁词表 v2；**不阻断**，改稿时清）：')
                    for _h in _hits:
                        say('  · ' + _h)
    except Exception as _e:
        say('[报警] 中文腔禁词扫描失败：%s' % _e)

    # ── S2 门覆盖率自检（V0.38：7 个门族）──
    families = {
        '门1 语感': '门1', '门2 节奏': '门2', '门3 卫生': '门3',
        '门4 重复与配额': '门4', '门5 账本': '门5', '门6 流程': '门6',
        '门7 分布对齐': '门7',
    }
    miss = [k for k, v in families.items() if v not in ran]
    if verbose:
        say('== 门覆盖率自检 ==')
        if miss:
            say('  本次未执行：' + '、'.join(miss))
        else:
            say('  全部 7 个门族均已执行。')
        if not args.plan:
            say('  · 门6 流程里的"规划表完整性"未执行（未提供 --plan）')
        say('  无机器门规则（靠人/表）：N2 风格层·N3 生成模式·N6 恶人编辑·'
            'N7 水文纪律·N11 遮名测试·N16 已证伪清单')
        say('  （N1 风格锚定＝style_anchor.py 生成锚点卡＋门7 每章自检；N8/N9 平台特化，非通用；'
            'N12 由门5 语癖卡覆盖；N13 由门6 瑕疵报警；G9 全修辞种类识别器未做）')
    else:
        parts = ['7/7 门族全部执行']
        if not args.plan:
            parts.append('未传 --plan → 门15 未执行')
        say('== 门覆盖率自检 == ' + '；'.join(parts) +
            ' ｜ 无机器门规则（靠人/表）：N2/N3/N6/N7/N11/N16（N1→style_anchor＋门7；'
            'N8/N9 平台特化；N12→门5；N13→门6；G9 未做）')

    def _write_out():
        """P7 修复（V0.41.1）：`--out` 恒落盘**全量**报告（与 V0.40 及更早一致）；
        quiet 只影响屏幕输出。quiet 模式下用子进程以 --verbose 重跑一次来生成全量报告。"""
        if not args.out:
            return
        if verbose:
            open(args.out, 'w', encoding='utf-8').write('\n'.join(log))
            return
        argv = [a for a in sys.argv[1:] if a not in ('--quiet',)]
        if '--verbose' not in argv and '--full-report' not in argv:
            argv.append('--verbose')
        try:
            subprocess.run([PY, os.path.abspath(__file__)] + argv,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            open(args.out, 'w', encoding='utf-8').write('\n'.join(log))

    if fails:
        say('== 打回清单 ==')
        for x in fails:
            say('  - ' + x)
        _write_out()
        return 2
    say('生效门全绿。下一步：恶人编辑（子代理按当前指示暂停，由作者决定执行方式）。')
    _write_out()
    return 0


if __name__ == '__main__':
    sys.exit(main())
