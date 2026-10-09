# -*- coding: utf-8 -*-
"""process_check.py — 门6（流程）· 合并入口（方案B，规则书 V0.37）

## 合并了什么

  · 原门15 `plan_check.py`：规划表完整性 ＋ 打字机模式
  · 原门16 `rhythm_check.py`：连续爽点／标题风格／身体性配额／失败章间隔／谈判闭环
  · 原门17 `imperfection_check.py`：受控瑕疵核对（**只报警**）

## 用法

  python process_check.py --chapters "chapters" [--tables 设定表.xlsx]
      [--plan "02_规划表_第03章.md"] [--waiver 受控瑕疵清单.json]

退出码：门15/16 打回即 2；门17 只报警。
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable or 'python'


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def emit(s=''):
    print(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chapters', required=True)
    ap.add_argument('--tables', default=None)
    ap.add_argument('--plan', default=None)
    ap.add_argument('--waiver', default=None)
    args = ap.parse_args()

    emit('=' * 72)
    emit('门6 流程（process_check.py ＝ 原门15 ＋ 原门16 ＋ 原门17）')
    emit('=' * 72)
    rc_all = 0

    emit('\n--- 6.1 规划表完整性＋打字机模式（plan_check.py）---')
    if args.plan and os.path.exists(args.plan):
        cmd = [PY, os.path.join(HERE, 'plan_check.py'), '--plan', args.plan,
               '--chapters-dir', args.chapters]
        rc, out = run(cmd)
        for line in out.rstrip().splitlines():
            emit('  ' + line)
        rc_all = max(rc_all, 2 if rc else 0)
    else:
        emit('  [未执行] 未提供 --plan（本章规划表 md）')

    emit('\n--- 6.2 节奏与身体性（rhythm_check.py）---')
    cmd = [PY, os.path.join(HERE, 'rhythm_check.py'), '--chapters-dir', args.chapters]
    if args.tables:
        cmd += ['--tables', args.tables]
    rc, out = run(cmd)
    for line in out.rstrip().splitlines():
        emit('  ' + line)
    rc_all = max(rc_all, 2 if rc else 0)

    emit('\n--- 6.3 受控瑕疵（imperfection_check.py，只报警）---')
    cmd = [PY, os.path.join(HERE, 'imperfection_check.py'), '--chapters', args.chapters]
    if args.waiver:
        cmd += ['--waiver', args.waiver]
    if args.tables:
        cmd += ['--tables', args.tables]
    rc, out = run(cmd)
    for line in out.rstrip().splitlines():
        emit('  ' + line)

    emit('\n' + '=' * 72)
    if rc_all:
        emit('门6 打回。')
        return 2
    emit('门6 通过（报警项由作者/恶人编辑复核）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
