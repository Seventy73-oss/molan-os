/** Shared DDL. SQLite keeps ? placeholders at query time; Postgres schema uses standard SQL. */

export const SCENES = [
  "topic",
  "book_setup",
  "outline",
  "chapter_outline",
  "chapter_body",
  "review",
  "humanize",
  "memory_extract",
  "chat",
] as const;

export function sqliteSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  logline TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  target_chapters INTEGER NOT NULL DEFAULT 12,
  words_per_chapter INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'empty',
  UNIQUE(book_id, number)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT,
  kind TEXT NOT NULL,
  current_revision_id TEXT
);

CREATE TABLE IF NOT EXISTS artifact_revisions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  skill_ids TEXT,
  scene TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scene TEXT NOT NULL,
  role TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS scene_routes (
  scene TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS writing_jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  status TEXT NOT NULL,
  from_chapter INTEGER,
  to_chapter INTEGER,
  current_chapter INTEGER,
  current_stage TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  auto_review INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  log_json TEXT NOT NULL DEFAULT '[]'
);


CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  scene TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  local INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_marks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  recycled_chapter INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, hook_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_slot
  ON artifacts(book_id, kind, ifnull(chapter_id, ''));

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bible_cards (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bible_cards_book ON bible_cards(book_id, kind, sort_order);
`;
}

export function postgresSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  logline TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  target_chapters INTEGER NOT NULL DEFAULT 12,
  words_per_chapter INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'empty',
  UNIQUE(book_id, number)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT,
  kind TEXT NOT NULL,
  current_revision_id TEXT
);

CREATE TABLE IF NOT EXISTS artifact_revisions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  skill_ids TEXT,
  scene TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scene TEXT NOT NULL,
  role TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS scene_routes (
  scene TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS writing_jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  status TEXT NOT NULL,
  from_chapter INTEGER,
  to_chapter INTEGER,
  current_chapter INTEGER,
  current_stage TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  auto_review INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  log_json TEXT NOT NULL DEFAULT '[]'
);


CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  scene TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  local INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_marks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  recycled_chapter INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, hook_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_slot
  ON artifacts (book_id, kind, (COALESCE(chapter_id, '')));

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bible_cards (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bible_cards_book ON bible_cards(book_id, kind, sort_order);
`;
}
/** Additive migrations for existing DBs (CREATE IF NOT EXISTS won't alter columns). */
export function migrateSqlite(exec: (sql: string) => void, run: (sql: string) => void) {
  exec(`
CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  scene TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  local INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_usage_book ON api_usage(book_id, created_at);
CREATE INDEX IF NOT EXISTS api_usage_created ON api_usage(created_at);

CREATE TABLE IF NOT EXISTS hook_marks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  recycled_chapter INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, hook_key)
);
`);
  const cols = [
    ["auto_review", "INTEGER NOT NULL DEFAULT 0"],
    ["max_retries", "INTEGER NOT NULL DEFAULT 1"],
    ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
    ["log_json", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const;
  for (const [name, type] of cols) {
    try {
      run(`ALTER TABLE writing_jobs ADD COLUMN ${name} ${type}`);
    } catch {
      // column exists
    }
  }
}

export function migratePostgres(exec: (sql: string) => Promise<void>) {
  return exec(`
CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  scene TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  local INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_usage_book ON api_usage(book_id, created_at);
CREATE INDEX IF NOT EXISTS api_usage_created ON api_usage(created_at);

CREATE TABLE IF NOT EXISTS hook_marks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  recycled_chapter INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, hook_key)
);
DO $$ BEGIN
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS auto_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS log_json TEXT NOT NULL DEFAULT '[]';
EXCEPTION WHEN others THEN NULL;
END $$;
`);
}
