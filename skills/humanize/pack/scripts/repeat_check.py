# -*- coding: utf-8 -*-
"""repeat_check.py — 门4（重复与配额）· 合并入口（方案B，规则书 V0.37）

## 合并了什么

  · 原门7a `dup_check.py`：精确重复／高相似／同构复述／跨章句尾复用／跨章长短语复用／句式频率
  · 原门7b `quota_check.py`：间隔制 11 项 ＋ 章级配额（明喻/金句/verbatim）

## 用法

  python repeat_check.py --files "chapters/*.md" --tables "设定表_书名.xlsx" \
      [--quota "../11_skills包/配额账本.json"] [--whitelist 回调白名单.txt]

退出码：任一部分打回即 2。
"""
import argparse
import glob
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
    ap.add_argument('--files', nargs='+', required=True)
    ap.add_argument('--tables', default=None, help='设定表（供句尾/短语复用豁免读伏笔台账）')
    ap.add_argument('--quota', default=None)
    ap.add_argument('--whitelist', default=None)
    ap.add_argument('--verbatim-list', default=None, dest='verbatim_list')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    files = []
    for p in args.files:
        files.extend(sorted(glob.glob(p)))
    if not files:
        print('no files', file=sys.stderr)
        return 1
    if not args.quota:
        for c in (os.path.join(HERE, '..', '11_skills包', '配额账本.json'),
                  os.path.join(HERE, '..', 'data', '配额账本.json')):
            if os.path.exists(c):
                args.quota = c
                break

    emit('=' * 72)
    emit('门4 重复与配额（repeat_check.py ＝ 原门7a ＋ 原门7b）')
    emit('=' * 72)
    rc_all = 0

    emit('\n--- 4.1 重复与同构（dup_check.py）---')
    cmd = [PY, os.path.join(HERE, 'dup_check.py')] + files
    if args.tables:
        cmd += ['--tables', args.tables]
    if args.whitelist:
        cmd += ['--whitelist', args.whitelist]
    rc, out = run(cmd)
    for line in out.rstrip().splitlines():
        emit('  ' + line)
    rc_all = max(rc_all, 2 if rc else 0)

    emit('\n--- 4.2 配额账本（quota_check.py）---')
    if not args.quota or not os.path.exists(args.quota):
        emit('  [未执行] 未找到配额账本（--quota）')
    else:
        cmd = [PY, os.path.join(HERE, 'quota_check.py'), '--quota', args.quota, '--files'] + files
        if args.verbatim_list:
            cmd += ['--verbatim-list', args.verbatim_list]
        rc, out = run(cmd)
        for line in out.rstrip().splitlines():
            emit('  ' + line)
        rc_all = max(rc_all, 2 if rc else 0)

    emit('\n' + '=' * 72)
    if rc_all:
        emit('门4 打回。')
        return 2
    emit('门4 通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
