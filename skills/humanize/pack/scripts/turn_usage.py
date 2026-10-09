# -*- coding: utf-8 -*-
"""按 turn 汇总 DSH 会话 token 用量，用于成本核算。

用法：python 20_成本测算/turn_usage.py <session.jsonl.zstd> [--from-turn N] [--to-turn M]
"""
import io
import json
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')
import zstandard  # noqa: E402


def load_lines(path):
    raw = open(path, 'rb').read()
    dctx = zstandard.ZstdDecompressor()
    return dctx.stream_reader(io.BytesIO(raw)).read().decode('utf-8', errors='replace').split('\n')


def collect(path):
    turns = {}
    for ln in load_lines(path):
        if '"usage"' not in ln:
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        d = o.get('data') or {}
        ch = (d.get('chunk') or {})
        if ch.get('type') != 'usage':
            continue
        u = ch.get('usage') or {}
        t = d.get('turn')
        if t is None:
            continue
        rec = turns.setdefault(t, {'in': 0, 'out': 0, 'cache': 0, 'reason': 0,
                                   'calls': 0, 'first': o.get('time'), 'last': o.get('time')})
        rec['in'] += u.get('inputTokens', 0)
        rec['out'] += u.get('outputTokens', 0)
        rec['cache'] += u.get('cacheReadTokens', 0)
        rec['reason'] += u.get('reasoningTokens', 0)
        rec['calls'] += 1
        rec['first'] = min(rec['first'] or o.get('time'), o.get('time'))
        rec['last'] = max(rec['last'] or o.get('time'), o.get('time'))
    return turns


def fmt(ts):
    return datetime.fromtimestamp(ts / 1000).strftime('%m-%d %H:%M') if ts else '?'


def main():
    path = sys.argv[1]
    turns = collect(path)
    print('%-6s %-12s %-12s %6s %12s %12s %12s %12s' % (
        'turn', '起', '止', '调用', '输入', '输出', '缓存读', '思考'))
    tot = {'in': 0, 'out': 0, 'cache': 0, 'reason': 0, 'calls': 0}
    for t in sorted(turns):
        r = turns[t]
        for k in tot:
            tot[k] += r[k]
        print('%-6s %-12s %-12s %6d %12s %12s %12s %12s' % (
            t, fmt(r['first']), fmt(r['last']), r['calls'],
            format(r['in'], ','), format(r['out'], ','),
            format(r['cache'], ','), format(r['reason'], ',')))
    print('-' * 96)
    print('%-6s %-25s %6d %12s %12s %12s %12s' % (
        '合计', '', tot['calls'], format(tot['in'], ','), format(tot['out'], ','),
        format(tot['cache'], ','), format(tot['reason'], ',')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
