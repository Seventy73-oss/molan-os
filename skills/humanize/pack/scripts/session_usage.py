# -*- coding: utf-8 -*-
"""统计 DSH 会话 token 用量（逐帧解压多帧 zstd）。

用法：python 20_成本测算/session_usage.py <session.jsonl.zstd> [更多...]
输出：每条会话的 usage 汇总（input/output/cached/reasoning tokens）＋ JSON。
"""
import io
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
import zstandard  # noqa: E402

USAGE_KEYS = ('input_tokens', 'output_tokens', 'inputTokens', 'outputTokens',
              'prompt_tokens', 'completion_tokens', 'total_tokens',
              'cached_tokens', 'cache_read_input_tokens', 'reasoning_tokens',
              'cacheReadTokens', 'reasoningTokens', 'cacheWriteTokens',
              'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens')
PAT = re.compile(r'"(' + '|'.join(USAGE_KEYS) + r')":\s*(\d+)')


def decompress_all(path):
    raw = open(path, 'rb').read()
    out = []
    dctx = zstandard.ZstdDecompressor()
    reader = dctx.stream_reader(io.BytesIO(raw))
    # stream_reader 处理连续帧
    buf = reader.read()
    return buf.decode('utf-8', errors='replace')


def usage_of(path):
    text = decompress_all(path)
    lines = [l for l in text.split('\n') if l.strip()]
    tot = {}
    rounds = 0
    for ln in lines:
        for k, v in PAT.findall(ln):
            tot[k] = tot.get(k, 0) + int(v)
        if '"usage"' in ln or 'output_tokens' in ln or 'outputTokens' in ln:
            rounds += 1
    return {'file': os.path.basename(os.path.dirname(path)),
            'bytes': os.path.getsize(path),
            'lines': len(lines), 'rounds': rounds, 'usage': tot}


def main():
    files = sys.argv[1:]
    if not files:
        print('用法: python session_usage.py <session.jsonl.zstd> [...]')
        return 1
    results = []
    for f in files:
        r = usage_of(f)
        results.append(r)
        print('=' * 70)
        print('会话 %s（压缩 %.1f MB，%d 行）' % (r['file'], r['bytes'] / 1e6, r['lines']))
        if not r['usage']:
            print('  未找到 usage 字段（可能仍在写入或格式不同）')
        for k, v in sorted(r['usage'].items(), key=lambda x: -x[1]):
            print('  %-28s %12s' % (k, format(v, ',')))
    out = '20_成本测算/_session_usage.json'
    json.dump(results, io.open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n→ %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
