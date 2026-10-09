import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "../api";

type Props = {
  value: string;
  models: ModelInfo[];
  placeholder?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  compact?: boolean;
  onChange: (value: string) => void;
};

/**
 * Searchable model select with free-text fallback. When the list is empty the
 * control behaves like a plain input so the user can still type an id by hand.
 */
export function ModelPicker({
  value,
  models,
  placeholder = "选择或输入模型 ID",
  disabled,
  allowEmpty,
  emptyLabel = "使用默认",
  compact,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) setQuery(value);
  }, [value, open]);

  useEffect(() => {
    function onDoc(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = models.filter((model) => !q || model.id.toLowerCase().includes(q) || (model.ownedBy ?? "").toLowerCase().includes(q));
    return list.slice(0, 80);
  }, [models, query]);

  const hasList = models.length > 0;

  function commit(next: string) {
    onChange(next);
    setQuery(next);
    setOpen(false);
  }

  return (
    <div ref={root} className={compact ? "model-picker compact" : "model-picker"}>
      <div className={open ? "picker-field open" : "picker-field"}>
        <input
          ref={input}
          value={open ? query : value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
          onFocus={() => {
            if (disabled) return;
            setOpen(true);
            // Start with an empty query so the full list is visible; typing then filters.
            setQuery("");
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!hasList) onChange(event.target.value);
            else setOpen(true);
          }}
          onBlur={() => {
            if (!hasList) return;
            // Keep typed custom ids when the list doesn't contain them.
            if (query.trim() && query.trim() !== value) onChange(query.trim());
            else setQuery(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(query.trim());
            }
            if (event.key === "Escape") {
              setOpen(false);
              setQuery(value);
            }
          }}
        />
        {hasList ? (
          <button
            type="button"
            className="picker-caret"
            tabIndex={-1}
            disabled={disabled}
            aria-label="打开模型列表"
            onClick={() => {
              setOpen((v) => !v);
              setQuery("");
              input.current?.focus();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
      </div>
      {open && hasList ? (
        <div className="picker-menu" role="listbox">
          {allowEmpty ? (
            <button type="button" className={!value ? "picker-option on" : "picker-option"} onMouseDown={(e) => e.preventDefault()} onClick={() => commit("")}>
              <span>{emptyLabel}</span>
            </button>
          ) : null}
          {filtered.length === 0 ? <div className="picker-empty">没有匹配的模型。回车使用「{query.trim() || "…"}」</div> : null}
          {filtered.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === value}
              className={model.id === value ? "picker-option on" : "picker-option"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(model.id)}
            >
              <span className="picker-id">{model.id}</span>
              {model.ownedBy ? <span className="picker-owner">{model.ownedBy}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
