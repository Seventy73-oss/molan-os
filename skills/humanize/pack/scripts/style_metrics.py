# -*- coding: utf-8 -*-
"""
style_metrics.py — 文风统计指标（V2 阶段0）
指标：
  - perplexity_mean / perplexity_std : token级困惑度（本地Qwen2.5-3B，GPU）
  - burstiness                       : 句长 标准差/均值
  - sentence_len_cv                  : 同 burstiness（显式命名）
  - mean_sentence_len                : 平均句长（字）
  - para_count / mean_para_len       : 段落数 / 平均段长
  - dialogue_ratio                   : 对话行占比（网文特写指标，引号开头行）
用法：
  python style_metrics.py 文件1.txt 文件2.txt ...          # 按整篇算
  python style_metrics.py --sample-chapters 1 --out xx.json 目录/*.txt
      # 对整本书txt按"第X章"切章，每本书随机抽N章分别打分
"""
import argparse, glob, json, random, re, sys, os
import statistics as st

SENT_END = re.compile(r'[。！？!?…]+[”』」)】]*')
CHAPTER = re.compile(
    r'^\s*(第[0-9一二三四五六七八九十百千两零〇]+[章节回]|\d{2,4}章)[^\n]{0,40}$', re.M)

def read_text(fp):
    """语料多为GBK，也有UTF-8，逐个探测"""
    with open(fp, "rb") as f:
        raw = f.read()
    for enc in ("utf-8", "gb18030", "utf-16"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("utf-8", errors="ignore")

def split_sentences(text):
    sents = [s.strip() for s in SENT_END.split(text) if s.strip()]
    return sents

def text_stats(text):
    paras = [p.strip() for p in re.split(r'\n+', text) if p.strip()]
    sents = split_sentences(text)
    lens = [len(s) for s in sents] or [0]
    para_lens = [len(p) for p in paras] or [0]
    lines = [p for p in paras]
    dia = sum(1 for p in lines if re.match(r'^[“"『「]', p))
    mean_len = st.mean(lens)
    return {
        "chars": len(text.replace('\n', '').replace(' ', '')),
        "n_sentences": len(lens),
        "mean_sentence_len": round(mean_len, 2),
        "burstiness": round(st.pstdev(lens) / mean_len, 3) if mean_len > 0 else 0.0,
        "sentence_len_cv": round(st.pstdev(lens) / mean_len, 3) if mean_len > 0 else 0.0,
        "para_count": len(paras),
        "mean_para_len": round(st.mean(para_lens), 1),
        "para_cv": round(st.pstdev(para_lens) / st.mean(para_lens), 3) if para_lens and st.mean(para_lens) > 0 else 0.0,
        "para_short5": sum(1 for L in para_lens if L <= 5),
        "para_long120": sum(1 for L in para_lens if L >= 120),
        "dialogue_ratio": round(dia / len(lines), 3) if lines else 0.0,
    }

class PPL:
    def __init__(self, model_dir, device="cuda"):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.torch = torch
        self.tok = AutoTokenizer.from_pretrained(model_dir)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_dir, dtype="auto").to(device).eval()
        self.device = device

    def score(self, text, max_chars=4000):
        """返回 token级 NLL 的 mean/std（=困惑度的对数域），以及 ppl"""
        torch = self.torch
        text = text[:max_chars]
        ids = self.tok(text, return_tensors="pt").input_ids.to(self.device)
        if ids.shape[1] < 8:
            return None
        with torch.no_grad():
            logits = self.model(ids).logits
        # 预测位置 t 的 token 用 logits[t-1]，丢掉第一个位置
        logits = logits[:, :-1, :]
        labels = ids[:, 1:]
        nll = torch.nn.functional.cross_entropy(
            logits.reshape(-1, logits.size(-1)), labels.reshape(-1),
            reduction="none")
        nll = nll.tolist()
        mean_nll = st.mean(nll)
        return {
            "nll_mean": round(mean_nll, 3),
            "nll_std": round(st.pstdev(nll), 3),
            "perplexity": round(2.718281828 ** mean_nll, 2),
            "n_tokens": len(nll),
        }

def iter_targets(paths, sample_chapters, seed=20260907):
    """[(label, text), ...]"""
    rng = random.Random(seed)
    for pat in paths:
        for fp in sorted(glob.glob(pat)):
            raw = read_text(fp)
            if sample_chapters and CHAPTER.search(raw):
                chapters = [c for c in CHAPTER.split(raw) if c.strip()]
                heads = CHAPTER.findall(raw)
                # chapters[i] 属于 heads[i]；正文太短的跳过
                pairs = [(h, c) for h, c in zip(heads, chapters) if len(c) > 800]
                if not pairs:
                    continue
                rng.shuffle(pairs)
                for h, c in pairs[:sample_chapters]:
                    yield (f"{os.path.basename(fp)}::{h.strip()[:20]}", c)
            else:
                yield (os.path.basename(fp), raw)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", help="文件或glob（目录/*.txt）")
    ap.add_argument("--model", default=os.path.join(os.path.dirname(__file__),
                    "..", "..", "models", "Qwen2.5-3B-Instruct"))
    ap.add_argument("--sample-chapters", type=int, default=0,
                    help=">0 时把每个文件按章切分、每本随机抽N章")
    ap.add_argument("--no-ppl", action="store_true", help="只算统计指标，不加载模型")
    ap.add_argument("--out", default=None, help="结果json输出路径")
    ap.add_argument("--max-items", type=int, default=0)
    args = ap.parse_args()

    ppl = None if args.no_ppl else PPL(args.model)
    rows = []
    for i, (label, text) in enumerate(iter_targets(args.paths, args.sample_chapters)):
        if args.max_items and i >= args.max_items:
            break
        row = {"label": label}
        row.update(text_stats(text))
        if ppl:
            p = ppl.score(text)
            if p:
                row.update(p)
        rows.append(row)
        done = " ".join(f"{k}={row.get(k)}" for k in
                        ("perplexity", "burstiness", "mean_sentence_len", "dialogue_ratio"))
        print(f"[{i+1}] {label[:40]}  {done}", flush=True)

    if not rows:
        print("没有匹配到任何文本", file=sys.stderr); sys.exit(1)

    def agg(key):
        vals = [r[key] for r in rows if key in r]
        if not vals:
            return None
        vals.sort()
        n = len(vals)
        return {"n": n, "min": vals[0], "p10": vals[int(0.10*(n-1))],
                "p50": vals[n//2], "p90": vals[int(0.90*(n-1))], "max": vals[-1]}

    summary = {k: agg(k) for k in
               ("perplexity", "nll_mean", "nll_std", "burstiness",
                "mean_sentence_len", "mean_para_len", "dialogue_ratio")}
    result = {"summary": summary, "rows": rows}
    out = args.out or "style_metrics_result.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print("\n=== 汇总（p10/p50/p90）===")
    for k, v in summary.items():
        if v:
            print(f"{k:20s} n={v['n']:4d}  p10={v['p10']:<9} p50={v['p50']:<9} p90={v['p90']}")
    print(f"\n已写入 {out}")

if __name__ == "__main__":
    main()
