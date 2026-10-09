# -*- coding: utf-8 -*-
"""
Qwen2.5-3B LoRA 微调 —— 网文续写
数据: corpus/train/webnovel_alpaca.jsonl
模型: 本地 models/Qwen2.5-3B-Instruct
输出: finetune/qwen-webnovel-lora
适配 transformers 5.x + peft 0.20
"""
import os, sys, json, argparse
os.environ.setdefault('NO_PROXY', '*')
os.environ.setdefault('no_proxy', '*')

import torch
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer,
    DataCollatorForSeq2Seq, set_seed
)
from peft import LoraConfig, get_peft_model

DATA = 'E:/agent文章内容/corpus/train/webnovel_alpaca.jsonl'
MODEL_DIR = 'E:/agent文章内容/models/Qwen2.5-3B-Instruct'
OUT_DIR = 'E:/agent文章内容/finetune/qwen-webnovel-lora'
CKPT_DIR = 'E:/agent文章内容/finetune/checkpoints'
MAX_LEN = 2048
SEED = 42

SYSTEM = "你是一个网文写作助手，请根据要求续写小说章节。"

def build_prompt(instruction):
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": instruction}]

def load_rows(data_path, max_samples=None):
    rows = []
    with open(data_path, encoding='utf-8') as f:
        for line in f:
            r = json.loads(line)
            rows.append({"instruction": r['instruction'], "output": r['output']})
    if max_samples:
        rows = rows[:max_samples]
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max_samples', type=int, default=None)
    ap.add_argument('--epochs', type=float, default=2.0)
    ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--grad_acc', type=int, default=16)
    ap.add_argument('--batch_size', type=int, default=1)
    ap.add_argument('--no_grad_ckpt', action='store_true')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--data', default=DATA, help='训练数据 jsonl 路径')
    ap.add_argument('--out', default=OUT_DIR, help='LoRA 输出目录')
    ap.add_argument('--ckpt', default=CKPT_DIR, help='中间 checkpoint 目录')
    ap.add_argument('--max_len', type=int, default=MAX_LEN)
    args = ap.parse_args()

    set_seed(SEED)
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.ckpt, exist_ok=True)

    rows = load_rows(args.data, args.max_samples)
    print(f"[data] {args.data} -> {len(rows)} samples", flush=True)

    tok = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print(f"[model] loading {MODEL_DIR} ...", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_DIR, torch_dtype=torch.float16, trust_remote_code=True, device_map='auto'
    )
    model.config.use_cache = False

    lora = LoraConfig(
        r=16, lora_alpha=32,
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        lora_dropout=0.05, bias='none', task_type='CAUSAL_LM'
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    def encode(ex):
        msgs = build_prompt(ex['instruction'])
        text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True) + ex['output'] + tok.eos_token
        enc = tok(text, max_length=MAX_LEN, truncation=True)
        return {'input_ids': enc['input_ids'], 'attention_mask': enc['attention_mask'],
                'labels': enc['input_ids'].copy()}

    ds = Dataset.from_list(rows).map(encode, remove_columns=['instruction', 'output'])
    print(f"[data] encoded {len(ds)} samples", flush=True)

    targs = TrainingArguments(
        output_dir=CKPT_DIR,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_acc,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type='cosine',
        warmup_steps=200,
        fp16=True,
        logging_steps=5,
        save_steps=50,
        save_total_limit=2,
        report_to=[],
        dataloader_num_workers=0,
        seed=SEED,
        gradient_checkpointing=not args.no_grad_ckpt,
        optim='adamw_torch',
    )
    collator = DataCollatorForSeq2Seq(tok, model=model, padding=True, label_pad_token_id=-100)
    trainer = Trainer(model=model, args=targs, train_dataset=ds, data_collator=collator, processing_class=tok)
    trainer.train(resume_from_checkpoint=args.resume)
    model.save_pretrained(OUT_DIR)
    tok.save_pretrained(OUT_DIR)
    print(f"[done] LoRA saved -> {OUT_DIR}", flush=True)

if __name__ == '__main__':
    main()
