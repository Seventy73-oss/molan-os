# -*- coding: utf-8 -*-
"""ledger_check.py — 门5（账本）· 合并入口（方案B，规则书 V0.37）

## 合并了什么

  · 原门13 `table_sync_check.py`：设定表与正文同步（先过，否则账本结论无意义）
  · 原门12 `consistency_check.py`：跨章事实一致性 C1~C8（账本驱动、无提名）
  · 原门14 `voice_table_check.py`：语癖卡对表

## 顺序（重要）

**先 5.1 表同步 → 再 5.2 事实一致 → 再 5.3 语癖卡。** 表不同步，后两步的结论不可信。

## 用法

  python ledger_check.py --chapters "chapters" --tables "设定表_书名.xlsx"

退出码：任一部分打回即 2。
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
    args = ap.parse_args()

    emit('=' * 72)
    emit('门5 账本（ledger_check.py ＝ 原门13 ＋ 原门12 ＋ 原门14）')
    emit('=' * 72)
    rc_all = 0

    emit('\n--- 5.1 设定表同步（table_sync_check.py）---')
    cmd = [PY, os.path.join(HERE, 'table_sync_check.py'), '--chapters', args.chapters]
    if args.tables:
        cmd += ['--tables', args.tables]
    rc, out = run(cmd)
    for line in out.rstrip().splitlines():
        emit('  ' + line)
    rc_all = max(rc_all, 2 if rc else 0)

    emit('\n--- 5.2 跨章事实一致性（consistency_check.py）---')
    cmd = [PY, os.path.join(HERE, 'consistency_check.py'), '--chapters', args.chapters]
    if args.tables:
        cmd += ['--tables', args.tables]
    rc, out = run(cmd)
    for line in out.rstrip().splitlines():
        emit('  ' + line)
    rc_all = max(rc_all, 2 if rc else 0)

    emit('\n--- 5.3 语癖卡对表（voice_table_check.py）---')
    cmd = [PY, os.path.join(HERE, 'voice_table_check.py'), '--chapters', args.chapters]
    if args.tables:
        cmd += ['--tables', args.tables]
    rc, out = run(cmd)
    for line in out.rstrip().splitlines():
        emit('  ' + line)
    rc_all = max(rc_all, 2 if rc else 0)

    emit('\n' + '=' * 72)
    if rc_all:
        emit('门5 打回。')
        return 2
    emit('门5 通过（报警项由恶人编辑复核）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
