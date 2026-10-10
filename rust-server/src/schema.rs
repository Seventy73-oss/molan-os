//! SQLite DDL mirrored from `server/src/db/schema.ts` (sqliteSchema + migrateSqlite).

pub const SCENES: &[&str] = &[
    "topic",
    "book_setup",
    "outline",
    "chapter_outline",
    "chapter_body",
    "review",
    "humanize",
    "memory_extract",
    "chat",
];

pub fn sqlite_schema() -> &'static str {
    r#"
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
  created_at TEXT NOT NULL,
  source_revision_id TEXT
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
  base_url TEXT,
  thinking_intensity TEXT NOT NULL DEFAULT 'medium'
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
  log_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT,
  lease_until TEXT
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

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  scene TEXT NOT NULL,
  chapter_id TEXT,
  chapter_number INTEGER,
  status TEXT NOT NULL,
  base_revision_id TEXT,
  result_revision_id TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS api_usage_book ON api_usage(book_id, created_at);
CREATE INDEX IF NOT EXISTS api_usage_created ON api_usage(created_at);
"#
}

/// Additive migrations matching Node `migrateSqlite`.
pub fn migrate_sqlite(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let cols = [
        ("auto_review", "INTEGER NOT NULL DEFAULT 0"),
        ("max_retries", "INTEGER NOT NULL DEFAULT 1"),
        ("retry_count", "INTEGER NOT NULL DEFAULT 0"),
        ("log_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("lease_owner", "TEXT"),
        ("lease_until", "TEXT"),
    ];
    for (name, ty) in cols {
        let sql = format!("ALTER TABLE writing_jobs ADD COLUMN {name} {ty}");
        let _ = conn.execute(&sql, []);
    }
    let _ = conn.execute(
        "ALTER TABLE scene_routes ADD COLUMN thinking_intensity TEXT NOT NULL DEFAULT 'medium'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE artifact_revisions ADD COLUMN source_revision_id TEXT",
        [],
    );
    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS artifact_revisions_unique ON artifact_revisions(artifact_id, revision)",
        [],
    );
    Ok(())
}
