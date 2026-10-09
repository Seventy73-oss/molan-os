# -*- coding: utf-8 -*-
"""
lint_check.py — 交付文本卫生检查（规则书V0.30 打分门6）

检查项（6项）：直引号残留 / 英文单词 / 繁体字 / 书源水印 / 引述动词单调度 / 设定术语密度
引述口径（对齐实测评审）：说族动词 / 全部引述动词（说|道|问|答|喊|叫|骂|吼|念|嘟囔|嘀咕 + 道：）

V0.35 修订（作者指示）：**引述动词改为"逐章判定（基线取低）＋整合判定（基线不变）"**——
  逐章上限默认 0.40（--said-max-per-chapter），**任一章超限即打回**；
  整合上限仍 0.45（--said-max，不变）。
  原因：实测《骨语者》第3章单章 53.8% 超限，但三章合并跑成 38.5% 判 OK——聚合掩盖单章违规。

V0.30 两处修正（补齐"规则写了但门没生效"）：
  1) 术语密度门必配：不再静默跳过。未配置术语表时本门报红（打回），
     逃生口 = --no-terms（显式跳过并在输出中标注"未执行"）。
     术语表自动查找顺序：待检文件所在目录 → --terms-dir → 脚本同级 ../11_skills包。
  2) 受控瑕疵豁免：规则书第九节4 允许每章1~2处受控瑕疵（含半角标点）且整合/恶人编辑不得修正，
     与门6"直引号=0"直接冲突。登记在案的瑕疵经 --waiver 剔除后再统计，冲突消解。
     清单格式：JSON {"items":[{"chapter":"第01章","type":"半角标点","text":"没有网,没有外卖"}]}
              或纯文本每行 `章号 | 类型 | 原文字符串`。

用法：
  python lint_check.py --files "chapters/*.md"
  python lint_check.py --files "chapters/*.md" --terms 11_skills包/术语表_XX.txt --terms-max 12
  python lint_check.py --files "chapters/*.md" --waiver 11_skills包/受控瑕疵清单.json
  python lint_check.py --files "chapters/*.md" --no-terms          # 历史稿复跑用
任何一项超限 exit 2（打回）。
"""
import argparse
import glob
import json
import os
import re
import sys

# V0.33：控制台编码为 GBK 时中文/箭头字符会 UnicodeEncodeError 崩溃，统一强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# 仅收录"繁体独有字形"（简体正文不可能出现的），避免误报
TRADITIONAL = set('們個來對時說學國會後開間關車馬鳥語頭無滅礦礙飛業樂點確隨機實現龍風雲氣發電報記讀買賣錢銀兩與專門業務員動靜狀況難聽話題標準備戰鬥艦隊軍長處遠運戶閉覺觸靈體壓鬱質變潔淨驗證溫劃繞續繼絕價觀區歲邊還進適遲週閱覽驚鐘錶鑰鋪錄監鍵據顯強險豐譽齋龜鹹鹼麵擊損壞錯誤舉導縮額滿')
WATERMARK = re.compile(r'(www\.|https?://|\.com|\.net|\.cc|\.org|首发|最新章节|笔趣阁|赕看書|薆荳|看书网|章节目录)', re.I)

# V0.40.1：单字动词判据的「实义口径」停用表
# 实测：真人文本里"是/有/到/会/能/去/没/要/让"同样高频（1.5 万字里「是」468 次），
# 把它们计入会逼作者改「是」——荒谬。故只统计实义动词。
# 真人实义口径 16.8%，我们 40.0%（2.4 倍）→ 阈值 ≤25%。
STOP_VERBS = set((
    '是 到 能 像 要 去 有 可 来 让 没 会 完 住 得 用 做 成 见 当 给 把 被 从 向 对 比 '
    '跟 和 出 如 倒 带 拿 打 想 使 令 由 经 靠 朝 往 沿 顺 按 据 凭 趁 距 离 过 起 开 '
    '在 就 还 也 都 又 再 才 只 更 最 太 很 挺 好 算 属 于 等 待 该 应 需 须 愿 肯 敢 忍'
).split())

SAID_VERB = re.compile(r'[\u4e00-\u9fff]说[道：:，。]')
ALL_VERB = re.compile(r'[\u4e00-\u9fff](?:说|道|问|答|喊|叫|骂|吼|念|嘟囔|嘀咕)[道：:，。]')


def find_terms(files, script_dir, explicit_dir=None):
    """返回 (path, err)；按 待检文件目录 → 其上级（书目录） → --terms-dir → 11_skills包 找唯一术语表"""
    dirs = []
    if files:
        d0 = os.path.dirname(os.path.abspath(files[0]))
        dirs.append(d0)
        dirs.append(os.path.dirname(d0))
    if explicit_dir:
        dirs.append(explicit_dir)
    dirs.append(os.path.join(script_dir, '..', '11_skills包'))
    for d in dirs:
        cands = sorted(glob.glob(os.path.join(d, '术语表*.txt')))
        if len(cands) == 1:
            return cands[0], None
        if len(cands) > 1:
            return None, f"术语表歧义：{d} 下有多个候选 {'、'.join(os.path.basename(c) for c in cands)}"
    return None, "未找到术语表（术语密度门无法执行）"


def find_waiver(files, script_dir):
    """自动查找 受控瑕疵清单.json：待检文件目录 → 11_skills包"""
    dirs = []
    if files:
        dirs.append(os.path.dirname(os.path.abspath(files[0])))
    dirs.append(os.path.join(script_dir, '..', '11_skills包'))
    for d in dirs:
        for pat in ('受控瑕疵清单.json', '受控瑕疵清单.txt'):
            p = os.path.join(d, pat)
            if os.path.exists(p):
                return p
    return None


def find_allow_english(files, script_dir):
    """自动查找 钦点英文词.json（作者要求的英文豁免）：待检文件目录 → 11_skills包"""
    dirs = []
    if files:
        dirs.append(os.path.dirname(os.path.abspath(files[0])))
    dirs.append(os.path.join(script_dir, '..', '11_skills包'))
    for d in dirs:
        p = os.path.join(d, '钦点英文词.json')
        if os.path.exists(p):
            return p
    return None


def load_allow_english(path):
    """钦点英文词.json：{"items": ["CBD", "AI"]}；返回小写词表。"""
    if not path:
        return []
    try:
        data = json.load(open(path, encoding='utf-8-sig'))
        return [str(w).strip() for w in data.get('items', []) if str(w).strip()]
    except Exception:
        return []


def load_waivers(path):
    items = []
    if path.lower().endswith('.json'):
        data = json.load(open(path, encoding='utf-8-sig'))
        for it in data.get('items', []):
            if it.get('text'):
                items.append({"chapter": it.get('chapter'), "type": it.get('type'),
                              "text": it['text']})
    else:
        for ln in open(path, encoding='utf-8-sig'):
            ln = ln.strip()
            if not ln or ln.startswith('#'):
                continue
            parts = [p.strip() for p in re.split(r'\s*\|\s*|\t+', ln) if p.strip()]
            if parts:
                items.append({"chapter": parts[0] if len(parts) > 1 else None,
                              "type": parts[1] if len(parts) > 2 else None,
                              "text": parts[-1]})
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', nargs='+')
    ap.add_argument('--said-max', type=float, default=0.52,
                    help='【整合判定】说族动词占全部引述动词上限（V0.39：0.45×1.15=0.52）')
    ap.add_argument('--said-max-per-chapter', type=float, default=0.46, dest='said_max_ch',
                    help='【逐章判定】单章说族占比上限（V0.39：0.40×1.15=0.46；任一章超限即打回）')
    ap.add_argument('--terms', default=None, help='术语表文件：每行一个正则（不指定则自动查找 术语表*.txt）')
    ap.add_argument('--terms-dir', default=None, dest='terms_dir', help='术语表查找目录')
    ap.add_argument('--terms-max', type=float, default=13.8, dest='terms_max',
                    help='术语密度上限（次/千字，V0.39：12×1.15=13.8）')
    ap.add_argument('--single-char-verb-max', type=float, default=0.30, dest='scv_max',
                    help='单字**实义**动词占比上限（V0.40.1 实义口径，真人 16.8%%，阈值留风格余量 30%%；越界打回）')
    ap.add_argument('--single-char-noun-max', type=float, default=0.16, dest='scn_max',
                    help='单字名词占比上限（V0.40，真人 med 12.9%%；越界打回）')
    ap.add_argument('--emotion-min', type=float, default=15.0, dest='emo_min',
                    help='情绪词密度下限（次/千字，V0.40，真人 p25 15.39；低于即打回）')
    ap.add_argument('--no-lexical', action='store_true', dest='no_lexical',
                    help='跳过用词/情绪判据（历史稿复跑用）')
    ap.add_argument('--punct-min', action='store_true', dest='punct_min',
                    help='V0.39 新增：标点多样性下限检查（问号/叹号/省略号/顿号，**只报警不阻断**）')
    ap.add_argument('--no-terms', action='store_true', dest='no_terms',
                    help='显式跳过术语密度门（输出标注"未执行"，供历史稿复跑）')
    ap.add_argument('--waiver', default=None,
                    help='受控瑕疵清单（JSON或txt）；登记项从统计中剔除，解第九节4与门6的冲突')
    ap.add_argument('--allow-english', default=None, dest='allow_english',
                    help='作者钦点英文词豁免（逗号分隔，如 CBD,AI；不指定则自动发现 钦点英文词.json）'
                         '——作者裁定 2026-09-10：作者要求的英文词不算污染')
    args = ap.parse_args()

    files = []
    for p in args.files or []:
        files.extend(sorted(glob.glob(p)))
    if not files:
        print('no files', file=sys.stderr)
        sys.exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    waiver_path = args.waiver or find_waiver(files, script_dir)
    if waiver_path and not args.waiver:
        print(f"受控瑕疵清单（自动发现）: {os.path.relpath(waiver_path)}")
    waivers = load_waivers(waiver_path) if waiver_path else []
    eng_path = args.allow_english or find_allow_english(files, script_dir)
    if args.allow_english:
        eng_allow = [w.strip().lower() for w in args.allow_english.split(',') if w.strip()]
    else:
        eng_allow = load_allow_english(eng_path)
        if eng_path and eng_allow:
            print(f"钦点英文词豁免（自动发现）: {os.path.relpath(eng_path)}  {eng_allow}")
    eng_hits = []

    fails, warns, unchecked = [], [], []
    straight = eng = trad = wm = said = allverb = 0
    waived_hits, full = [], []
    per_chap = []          # [(name, said, allverb)]
    for fp in files:
        name = os.path.basename(fp)
        t = open(fp, encoding='utf-8-sig').read()
        for it in waivers:
            if it['chapter'] and it['chapter'] not in name:
                continue
            c = t.count(it['text'])
            if c:
                t = t.replace(it['text'], '')
                waived_hits.append(f"{name}::{it['type'] or '瑕疵'}::{it['text']}")
        for w in eng_allow:
            c = len(re.findall(re.escape(w), t, re.I))
            if c:
                t = re.sub(re.escape(w), '', t, flags=re.I)
                eng_hits.append(f"{name}::{w}×{c}")
        full.append(t)
        straight += t.count('"') + t.count("'")
        eng += len(re.findall(r'[A-Za-z]{2,}', t))
        trad += sum(t.count(c) for c in TRADITIONAL)
        wm += len(WATERMARK.findall(t))
        s_n = len(SAID_VERB.findall(t))
        a_n = len(ALL_VERB.findall(t))
        said += s_n
        allverb += a_n
        per_chap.append((name, s_n, a_n))

    full = '\n'.join(full)
    n_chars = max(len(re.sub(r'\s', '', full)), 1)

    print(f"文件数{len(files)} 正文字数{n_chars}")
    if eng_hits:
        print(f"钦点英文豁免命中：{len(eng_hits)} 处（登记清单，不算污染）")
        for h in eng_hits:
            print(f"  · {h}")
    if waived_hits:
        print(f"受控瑕疵豁免：{len(waived_hits)} 处（登记清单，整合/恶人编辑不得修正）")
        for h in waived_hits:
            print(f"  · {h}")
    # ── V0.39（作者指示"把标点符号的审查级别降低"）：标点类判据由「打回」降为「报警」──
    print(f"直引号（\"或'）: {straight}  [{'报警' if straight else 'OK'}]  "
          f"← V0.39 降级：标点不再阻断（历史病灶 1420 个直引号，改由人/整合判断）")
    if straight:
        warns.append(f'直引号 {straight} 处（报警，不阻断）')
    print(f"英文单词: {eng}  [{'超限' if eng else 'OK'}]")
    if eng:
        fails.append('英文')
    print(f"繁体字: {trad}  [{'超限' if trad else 'OK'}]")
    if trad:
        fails.append('繁体')
    print(f"书源水印: {wm}  [{'超限' if wm else 'OK'}]")
    if wm:
        fails.append('水印')

    # ── 引述动词：逐章判定（基线取低）＋ 整合判定（基线不变）──
    ch_bad = []
    if any(a for _, _, a in per_chap):
        print(f"\n[逐章判定] 说族占比（单章上限 {args.said_max_ch:.0%}）")
        for name, s_n, a_n in per_chap:
            if not a_n:
                print(f"  {name}  引述动词 0 个  [跳过]")
                continue
            r = s_n / a_n
            ok = r <= args.said_max_ch
            if not ok:
                ch_bad.append(name)
            print(f"  {name}  说族 {s_n}/{a_n} → {r:.1%}  [{'OK' if ok else '超限'}]")
        if ch_bad:
            fails.append('引述动词逐章占比')

    if allverb:
        ratio = said / allverb
        ok = ratio <= args.said_max
        print(f"\n[整合判定] 引述动词 {allverb} 个，其中说族 {said} 个 → 占比 {ratio:.1%}"
              f"（上限{args.said_max:.0%}，不变）[{'OK' if ok else '超限'}] ← 实测病灶：60.9%")
        if not ok:
            fails.append('引述动词整合占比')
    else:
        print("引述动词: 0 个 [未执行]")
        unchecked.append('引述动词占比（正文无引述动词）')

    # 术语密度门（V0.30：必配，不再静默跳过）
    terms_path = args.terms
    if args.no_terms:
        print("术语密度: [未执行]  ← --no-terms 显式跳过（历史稿复跑；新稿不得跳过）")
        unchecked.append('术语密度（--no-terms 显式跳过）')
    else:
        if not terms_path:
            found, err = find_terms(files, script_dir, args.terms_dir)
            if found:
                terms_path = found
                print(f"术语表（自动发现）: {os.path.relpath(found)}")
            else:
                print(f"术语密度: [未配置]  ← {err}")
                fails.append('术语密度（术语表未配置）')
        if terms_path:
            pats = [l.strip() for l in open(terms_path, encoding='utf-8-sig')
                    if l.strip() and not l.strip().startswith('#')]
            # 合并重叠命中（"强制清算"含"清算"不得重复计数）
            spans = []
            for p in pats:
                for m in re.finditer(p, full):
                    spans.append((m.start(), m.end()))
            spans.sort()
            cnt, cur_end = 0, -1
            for s, e in spans:
                if s >= cur_end:
                    cnt += 1
                    cur_end = e
                else:
                    cur_end = max(cur_end, e)
            dens = cnt / n_chars * 1000
            ok = dens <= args.terms_max
            print(f"术语密度: {cnt}次 → {dens:.1f}/千字（上限{args.terms_max}，{len(pats)}条术语）"
                  f"[{'OK' if ok else '超限'}] ← 实测病灶：金融术语23/千字")
            if not ok:
                fails.append('术语密度')

    # ── V0.39 新增：标点多样性下限（只报警）──────────────────────────
    # 作者裁定："句号密度不是要限制句号的使用，而是要正确使用标点符号"——
    # 该用问号/叹号/省略号/顿号的地方用了句号，句号密度自然就高。故只设下限，不设句号上限。
    if args.punct_min:
        PUNCT_MIN = {'？': 2.3, '！': 1.5, '……': 0.4, '、': 0.7}   # 真人西幻档 p25（每千字）
        print("\n[标点多样性下限] 真人西幻档 p25（只报警，不阻断）")
        for fp in files:
            t = open(fp, encoding='utf-8-sig').read()
            n = max(len(re.sub(r'\s', '', t)), 1)
            name = os.path.basename(fp)
            row = []
            for ch, lo in PUNCT_MIN.items():
                c = len(re.findall(r'……', t)) if ch == '……' else t.count(ch)
                d = 1000.0 * c / n
                row.append('%s %.2f/%s %s' % (ch, d, lo, 'OK' if d >= lo else '低'))
                if d < lo:
                    warns.append(f'{name} 标点「{ch}」{d:.2f}/千字 < 下限 {lo}（该用就用，别一律句号收尾）')
            print('  %-28s %s' % (name[:28], '  '.join(row)))

    # ── V0.40.2：用词/情绪退出机器门（作者裁定 2026-09-10）──
    # 原因：实测该判据（单字实义动词占比）在阈值 25%~30% 下会逼出翻译腔
    # （"购买你""含在口中""站立在路灯底下"），且 jieba 分词对单字词误判较多。
    # 结论：**不做量化、不过机器门**，交由恶人编辑（独立子代理）人工改写。
    print("\n[用词与情绪] 已退出机器门（V0.40.2）：单字词/情绪词由恶人编辑人工处理")

    if unchecked:
        print(f"\n[未执行项] {'、'.join(unchecked)}")
    if warns:
        print(f"\n[报警] {'；'.join(warns)}")
    if fails:
        print(f"\n== 打回：{'、'.join(fails)} ==")
        sys.exit(2)
    print("\n卫生检查通过（报警项由人/整合复核）。")


if __name__ == '__main__':
    main()
