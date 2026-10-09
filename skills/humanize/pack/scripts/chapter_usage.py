# -*- coding: utf-8 -*-
"""按用户消息切分会话，统计「写第01章」这一段的 token 用量。

用法：python 20_成本测算/chapter_usage.py <session.jsonl.zstd> [关键词]
"""
import io
import json
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')
import zstandard  # noqa: E402

SKIP_PREFIX = ('Current runtime context', 'Updated instructions', '<system', 'Instructions from')


def load(path):
    raw = open(path, 'rb').read()
    return zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read().decode(
        'utf-8', errors='replace')


def main():
    path = sys.argv[1]
    key = sys.argv[2] if len(sys.argv) > 2 else '重新写ai大法师'
    text = load(path)

    users = []
    usages = []
    for ln in text.split('\n'):
        if not ln.strip():
            continue
        if '"user/message"' in ln:
            try:
                o = json.loads(ln)
            except Exception:
                continue
            d = o.get('data') or {}
            c = d.get('content')
            t = ''
            if isinstance(c, list):
                for x in c:
                    if isinstance(x, dict) and x.get('type') == 'text':
                        t += x.get('text', '')
            if t.strip() and not t.startswith(SKIP_PREFIX):
                users.append((o.get('time'), t.replace('\n', ' ').strip()))
        elif '"usage"' in ln:
            try:
                o = json.loads(ln)
            except Exception:
                continue
            d = o.get('data') or {}
            ch = d.get('chunk') or {}
            if ch.get('type') == 'usage':
                usages.append((o.get('time'), d.get('turn'), ch.get('usage') or {}))

    users.sort()
    print('用户消息 %d 条，usage 记录 %d 条' % (len(users), len(usages)))
    print('\n最近 8 条用户消息：')
    for ts, t in users[-8:]:
        print('  %s  %s' % (datetime.fromtimestamp(ts / 1000).strftime('%m-%d %H:%M:%S'), t[:70]))

    # 找到关键词那条用户消息的时间，之后的 usage 全算这一段
    start_ts = None
    for ts, t in users:
        if key in t:
            start_ts = ts
    if start_ts is None:
        print('\n未找到关键词「%s」，请手动指定' % key)
        return 1
    print('\n切分起点：%s（关键词「%s」）' % (
        datetime.fromtimestamp(start_ts / 1000).strftime('%m-%d %H:%M:%S'), key))

    tot = {'in': 0, 'out': 0, 'cache': 0, 'reason': 0}
    calls = 0
    turns = set()
    for ts, turn, u in usages:
        if ts >= start_ts:
            tot['in'] += u.get('inputTokens', 0)
            tot['out'] += u.get('outputTokens', 0)
            tot['cache'] += u.get('cacheReadTokens', 0)
            tot['reason'] += u.get('reasoningTokens', 0)
            calls += 1
            turns.add(turn)
    print('\n=== 「写第01章」这一段（turn %s）===' % sorted(x for x in turns if x is not None))
    print('  API 调用 %d 次' % calls)
    print('  输入 token      %12s' % format(tot['in'], ','))
    print('  输出 token      %12s' % format(tot['out'], ','))
    print('  缓存读 token    %12s' % format(tot['cache'], ','))
    print('  思考 token      %12s' % format(tot['reason'], ','))
    return 0


if __name__ == '__main__':
    sys.exit(main())
