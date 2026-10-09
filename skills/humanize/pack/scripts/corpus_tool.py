# -*- coding: utf-8 -*-
"""corpus_tool.py — 语料入库工具（扫描 / 去重 / 清洗）

用法：
  python corpus_tool.py scan   --dir <目录> [--dir <目录2> ...]
  python corpus_tool.py dedupe --dir <目录> [--dir <目录2> ...] [--threshold 0.55]
  python corpus_tool.py clean  --dir <目录> --out <输出目录> [--keep-header]

设计原则（对齐项目纪律）：
  · 只做可复现的机械处理，不做"润色"；
  · 扫描结果先给人看，再由人决定删哪些（不自动删书）；
  · 清洗只删"站点 chrome / 广告 / 榜单标注"，**不删正文任何一个字**。
"""
import argparse
import glob
import hashlib
import io
import os
import re
import sys
from collections import defaultdict

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ── 站点 chrome / 广告 / 榜单标注（只删这些）──
NOISE = [
    ('站点名', re.compile(r'空白小说|鬼吹灯◎|笔趣阁|笔趣看|无弹窗|免费阅读|全文阅读|'
                          r'请记住本站|记住网址|手机版阅读|加入书签|推荐阅读|章节报错')),
    ('URL', re.compile(r'(www\.|https?://|\.com|\.net|\.cc|\.org)', re.I)),
    ('榜单标注', re.compile(r'榜单来源|抓取站点|赤戟公众号|口碑增量榜')),
    ('作者话', re.compile(r'^(作者的话|PS[:：]|ps[:：]|求(票|收藏|推荐)|求月票|'
                          r'感谢.{0,10}(打赏|月票|推荐票)|本章完$)')),
    ('空章', re.compile(r'^\s*$')),
]
# 源站截断占位（这些章是残缺的，不是正文）
TRUNC = re.compile(r'正在手打中|请稍等片刻|内容更新后|请重新刷新页面|正在加载|'
                   r'本章未完|下页更精彩|点击下一页')
CHAPTER = re.compile(r'^\s*第\s*[\d一二三四五六七八九十百零两]+\s*章')
HEADER_FIELDS = re.compile(r'^(《.*》|作者[:：].*|榜单来源[:：].*|抓取站点[:：].*|来源[:：].*)$')


def read_text(fp):
    raw = io.open(fp, 'rb').read()
    for enc in ('utf-8', 'gb18030', 'gbk'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('utf-8', 'replace')


def parse_meta(text):
    """从头部 6 行取书名/作者。"""
    title = author = ''
    for ln in text.split('\n')[:8]:
        ln = ln.strip()
        m = re.match(r'^《(.+?)》$', ln)
        if m and not title:
            title = m.group(1)
        m = re.match(r'^作者[:：]\s*(.+)$', ln)
        if m and not author:
            author = m.group(1).strip()
    return title, author


def norm_key(s):
    return re.sub(r'[《》\s：:！!？?，,。·\-—~…、]', '', s or '')


def body_after_header(text):
    """去掉头部元信息，返回正文。"""
    lines = text.split('\n')
    i = 0
    while i < len(lines) and (i < 8):
        s = lines[i].strip()
        if s and not HEADER_FIELDS.match(s):
            break
        i += 1
    return '\n'.join(lines[i:])


def stats(text):
    body = body_after_header(text)
    chars = len(re.sub(r'\s', '', body))
    lines = body.split('\n')
    ch_idx = [i for i, l in enumerate(lines) if CHAPTER.match(l)]
    # 每章正文长度（章名行到下一章名行之间）
    lens = []
    for k, i in enumerate(ch_idx):
        j = ch_idx[k + 1] if k + 1 < len(ch_idx) else len(lines)
        seg = '\n'.join(lines[i + 1:j])
        lens.append(len(re.sub(r'\s', '', seg)))
    ch_with_body = sum(1 for L in lens if L >= 200)
    empty = sum(1 for L in lens if L < 80)
    # 截断章：该章含源站占位
    trunc_ch = 0
    for k, i in enumerate(ch_idx):
        j = ch_idx[k + 1] if k + 1 < len(ch_idx) else len(lines)
        if TRUNC.search('\n'.join(lines[i + 1:j])):
            trunc_ch += 1
    noise = {}
    for name, pat in NOISE:
        n = len(pat.findall(body)) if name != '空章' else 0
        if n:
            noise[name] = n
    title, author = parse_meta(text)
    return {'chars': chars, 'chapters': len(ch_idx), 'ch_with_body': ch_with_body,
            'body_ratio': (ch_with_body / len(ch_idx)) if ch_idx else 0.0,
            'empty_ch': empty, 'trunc_ch': trunc_ch,
            'trunc_ratio': (trunc_ch / len(ch_idx)) if ch_idx else 0.0,
            'title': title, 'author': author, 'noise': noise}


def fingerprint(text, n=8, cap=4000):
    """字符 n-gram 指纹（用于近重复检测）。"""
    body = re.sub(r'\s', '', body_after_header(text))
    body = body[:cap]
    if len(body) < n:
        return set()
    return {hashlib.md5(body[i:i + n].encode()).hexdigest()[:12]
            for i in range(0, len(body) - n + 1, 3)}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def iter_files(dirs):
    out = []
    for d in dirs:
        out += sorted(glob.glob(os.path.join(d, '*.txt')))
    return out


def cmd_scan(dirs):
    files = iter_files(dirs)
    print(f'扫描 {len(files)} 个文件')
    print(f"{'文件':<38}{'字数':>9}{'章数':>6}{'有正文':>7}{'截断章':>7}{'截断%':>7}  噪音")
    rows = []
    for fp in files:
        t = read_text(fp)
        s = stats(t)
        rows.append((fp, s))
        flag = '⚠' if (s['chars'] < 8000 or s['trunc_ratio'] > 0.1) else ' '
        print(f"{os.path.basename(fp)[:36]:<38}{s['chars']:>9}{s['chapters']:>6}"
              f"{s['ch_with_body']:>7}{s['trunc_ch']:>7}{s['trunc_ratio']*100:>6.0f}% {flag}"
              f"{s['noise'] if s['noise'] else ''}")
    bad = [(fp, s) for fp, s in rows if s['chars'] < 8000 or s['trunc_ratio'] > 0.1]
    print(f'\n不合格（字数<8000 或 截断章>10%）：{len(bad)} 个')
    for fp, s in bad:
        print(f"  · {os.path.basename(fp)}  字数{s['chars']} 章{s['chapters']} "
              f"截断{s['trunc_ch']}（{s['trunc_ratio']*100:.0f}%）")
    ok = [(fp, s) for fp, s in rows if s not in bad]
    print(f'\n合格 {len(ok)} 本 / {sum(s["chars"] for _, s in ok)} 字')
    return rows


def fname_key(fp):
    """从文件名取"书名_作者"键（老语料没有头部元信息，只能靠文件名）。"""
    b = os.path.splitext(os.path.basename(fp))[0]
    b = re.sub(r'^\d+[_\-\s]*', '', b)
    b = re.sub(r'[_\-\s]*(前\d+章|全本|完结|精校).*$', '', b)
    return norm_key(b)


def cmd_dedupe(dirs, threshold):
    files = iter_files(dirs)
    data = []
    for fp in files:
        t = read_text(fp)
        title, author = parse_meta(t)
        data.append((fp, title, author, fingerprint(t)))
    print(f'去重检查：{len(data)} 个文件\n')
    # 0) 文件名键（跨新旧语料最可靠）
    fkey = defaultdict(list)
    for fp, _, _, _ in data:
        fkey[fname_key(fp)].append(fp)
    dup_f = {k: v for k, v in fkey.items() if len(v) > 1 and k}
    print(f'【文件名键重复】{len(dup_f)} 组')
    for k, v in dup_f.items():
        print(f'  {k}: ' + '  |  '.join(os.path.basename(x) for x in v))
    if not dup_f:
        print('  无')
    # 1) 同名同作者
    key = defaultdict(list)
    for fp, title, author, _ in data:
        if title:
            key[(norm_key(title), norm_key(author))].append(fp)
    dup_meta = {k: v for k, v in key.items() if len(v) > 1}
    print(f'\n【头部同名同作者】{len(dup_meta)} 组')
    for (t, a), v in dup_meta.items():
        print(f'  {t} / {a}: ' + '  |  '.join(os.path.basename(x) for x in v))
    if not dup_meta:
        print('  无')
    # 2) 内容近重复
    print(f'\n【内容近重复 jaccard≥{threshold}】')
    found = 0
    for i in range(len(data)):
        for j in range(i + 1, len(data)):
            r = jaccard(data[i][3], data[j][3])
            if r >= threshold:
                found += 1
                print(f'  {r:.2f}  {os.path.basename(data[i][0])}  ↔  {os.path.basename(data[j][0])}')
    if not found:
        print('  无')
    return dup_f, dup_meta


def cmd_clean(dirs, out, keep_header=False, drop_trunc=True, min_chars=50000):
    os.makedirs(out, exist_ok=True)
    files = iter_files(dirs)
    n = dropped = 0
    for fp in files:
        t = read_text(fp)
        s = stats(t)
        if s['chars'] < 8000:
            print(f'  跳过（字数不足 {s["chars"]}）: {os.path.basename(fp)}')
            continue
        lines = t.split('\n')
        # 先定位章边界，整章剔除含源站截断占位的段
        if drop_trunc:
            ch_idx = [i for i, l in enumerate(lines) if CHAPTER.match(l)]
            drop_ranges = []
            for k, i in enumerate(ch_idx):
                j = ch_idx[k + 1] if k + 1 < len(ch_idx) else len(lines)
                if TRUNC.search('\n'.join(lines[i + 1:j])):
                    drop_ranges.append((i, j))
            for i, j in reversed(drop_ranges):
                del lines[i:j]
        out_lines = []
        for ln in lines:
            raw = ln.rstrip()
            st = raw.strip()
            if not keep_header and HEADER_FIELDS.match(st):
                continue
            if re.search(r'空白小说|鬼吹灯◎|笔趣阁|笔趣看|无弹窗|请记住本站|记住网址|'
                         r'手机版阅读|加入书签|章节报错|榜单来源|抓取站点|赤戟公众号', st):
                continue
            if re.search(r'(www\.|https?://|\.com|\.net|\.cc)', st, re.I):
                continue
            if re.match(r'^(作者的话|PS[:：]|ps[:：]|求(票|收藏|推荐)|求月票|感谢.{0,10}(打赏|月票|推荐票))', st):
                continue
            if re.match(r'^(章节[:：]\s*\d+|={4,}|-{4,})$', st):
                continue
            out_lines.append(raw)
        body = '\n'.join(out_lines)
        body = re.sub(r'\n{3,}', '\n\n', body).strip() + '\n'
        chars = len(re.sub(r'\s', '', body))
        if chars < min_chars:
            print(f'  丢弃（剔除截断后仅 {chars} 字 < {min_chars}）: {os.path.basename(fp)}')
            dropped += 1
            continue
        dst = os.path.join(out, os.path.basename(fp))
        io.open(dst, 'w', encoding='utf-8').write(body)
        n += 1
    print(f'\n清洗完成：{n} 个文件 → {out}（丢弃 {dropped} 个）')
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['scan', 'dedupe', 'clean'])
    ap.add_argument('--dir', action='append', required=True)
    ap.add_argument('--out', default=None)
    ap.add_argument('--threshold', type=float, default=0.55)
    ap.add_argument('--keep-header', action='store_true')
    ap.add_argument('--no-drop-trunc', action='store_false', dest='drop_trunc',
                    help='不整章剔除源站截断段（默认剔除）')
    ap.add_argument('--min-chars', type=int, default=50000, dest='min_chars',
                    help='清洗后低于此字数的整本丢弃（默认 50000）')
    args = ap.parse_args()
    if args.cmd == 'scan':
        cmd_scan(args.dir)
    elif args.cmd == 'dedupe':
        cmd_dedupe(args.dir, args.threshold)
    else:
        if not args.out:
            print('clean 需要 --out', file=sys.stderr)
            return 1
        cmd_clean(args.dir, args.out, args.keep_header, args.drop_trunc, args.min_chars)
    return 0


if __name__ == '__main__':
    sys.exit(main())
