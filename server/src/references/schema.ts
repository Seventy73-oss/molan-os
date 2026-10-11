/** Additive, portable schema; reference material never becomes a manuscript artifact. */
export function referenceSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS novel_sources (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
  origin_kind TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  char_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS novel_sources_owner ON novel_sources(owner_id, created_at);
CREATE TABLE IF NOT EXISTS novel_chapters (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
  char_count INTEGER NOT NULL, content_hash TEXT NOT NULL, UNIQUE(source_id, ordinal)
);
CREATE INDEX IF NOT EXISTS novel_chapters_source ON novel_chapters(owner_id, source_id, ordinal);
CREATE TABLE IF NOT EXISTS novel_jobs (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, selection_json TEXT NOT NULL, focus_json TEXT NOT NULL DEFAULT '[]',
  progress INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
  model_label TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS novel_jobs_owner ON novel_jobs(owner_id, created_at);
CREATE TABLE IF NOT EXISTS novel_cards (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_id TEXT NOT NULL, job_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, principle TEXT NOT NULL, application TEXT NOT NULL,
  caution TEXT NOT NULL, evidence_json TEXT NOT NULL, stages_json TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS novel_cards_source ON novel_cards(owner_id, source_id, created_at);
CREATE TABLE IF NOT EXISTS novel_book_links (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, card_id TEXT NOT NULL, book_id TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(book_id, card_id)
);
CREATE INDEX IF NOT EXISTS novel_book_links_book ON novel_book_links(book_id);
`;
}
