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

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT '',
  chapter_number INTEGER,
  mode TEXT NOT NULL DEFAULT 'legacy_current',
  rendered_text TEXT NOT NULL,
  rendered_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  generation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_snapshots_book ON context_snapshots(book_id, created_at);

CREATE TABLE IF NOT EXISTS story_book_heads (
  book_id TEXT PRIMARY KEY,
  story_epoch INTEGER NOT NULL DEFAULT 0 CHECK (story_epoch >= 0),
  fact_set_version INTEGER NOT NULL DEFAULT 0 CHECK (fact_set_version >= 0),
  protocol_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_publications (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  body_revision_id TEXT NOT NULL,
  publication_version INTEGER NOT NULL CHECK (publication_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  memory_state TEXT NOT NULL CHECK (
    memory_state IN ('pending', 'proposed', 'ready', 'failed', 'needs_review')
  ),
  accepted_at TEXT NOT NULL,
  accepted_by TEXT NOT NULL DEFAULT 'author'
);
CREATE UNIQUE INDEX IF NOT EXISTS chapter_publications_version
  ON chapter_publications(book_id, chapter_id, publication_version);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_publication_per_chapter
  ON chapter_publications(book_id, chapter_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS chapter_publications_book
  ON chapter_publications(book_id, status);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  publication_id TEXT,
  source_revision_id TEXT NOT NULL,
  basis_epoch INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL DEFAULT 'molan.memory-proposal/v1',
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'extracting', 'proposed', 'accepted', 'rejected', 'stale', 'failed')
  ),
  summary TEXT NOT NULL DEFAULT '',
  operations_json TEXT NOT NULL DEFAULT '[]',
  decision_json TEXT,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_proposals_book ON memory_proposals(book_id, status, created_at);
CREATE TABLE IF NOT EXISTS story_fact_sets (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  publication_id TEXT,
  source_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'invalidated')),
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_facts (
  id TEXT PRIMARY KEY,
  fact_set_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  predicate TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL DEFAULT '{}',
  evidence_quote TEXT NOT NULL DEFAULT '',
  source_revision_id TEXT NOT NULL,
  publication_id TEXT,
  effective_from_chapter INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_operation_results (
  book_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(book_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS story_outbox (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'obsolete')
  ),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS story_outbox_status ON story_outbox(status, next_run_at);
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

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT '',
  chapter_number INTEGER,
  mode TEXT NOT NULL DEFAULT 'legacy_current',
  rendered_text TEXT NOT NULL,
  rendered_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  generation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_snapshots_book ON context_snapshots(book_id, created_at);
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
    ["lease_owner", "TEXT"],
    ["lease_until", "TEXT"],
  ] as const;
  for (const [name, type] of cols) {
    try {
      run(`ALTER TABLE writing_jobs ADD COLUMN ${name} ${type}`);
    } catch {
      // column exists
    }
  }
  try {
    run(`ALTER TABLE scene_routes ADD COLUMN thinking_intensity TEXT NOT NULL DEFAULT 'medium'`);
  } catch {
    // column exists
  }
  try {
    run(`ALTER TABLE artifact_revisions ADD COLUMN source_revision_id TEXT`);
  } catch {
    // column exists
  }
  try {
    run(`CREATE UNIQUE INDEX IF NOT EXISTS artifact_revisions_unique ON artifact_revisions(artifact_id, revision)`);
  } catch {
    // may fail if duplicates exist — do not delete history
  }
  exec(`
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
`);
  exec(`
CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT '',
  chapter_number INTEGER,
  mode TEXT NOT NULL DEFAULT 'legacy_current',
  rendered_text TEXT NOT NULL,
  rendered_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  generation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_snapshots_book ON context_snapshots(book_id, created_at);

CREATE TABLE IF NOT EXISTS story_book_heads (
  book_id TEXT PRIMARY KEY,
  story_epoch INTEGER NOT NULL DEFAULT 0 CHECK (story_epoch >= 0),
  fact_set_version INTEGER NOT NULL DEFAULT 0 CHECK (fact_set_version >= 0),
  protocol_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_publications (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  body_revision_id TEXT NOT NULL,
  publication_version INTEGER NOT NULL CHECK (publication_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  memory_state TEXT NOT NULL CHECK (
    memory_state IN ('pending', 'proposed', 'ready', 'failed', 'needs_review')
  ),
  accepted_at TEXT NOT NULL,
  accepted_by TEXT NOT NULL DEFAULT 'author'
);
CREATE UNIQUE INDEX IF NOT EXISTS chapter_publications_version
  ON chapter_publications(book_id, chapter_id, publication_version);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_publication_per_chapter
  ON chapter_publications(book_id, chapter_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS chapter_publications_book
  ON chapter_publications(book_id, status);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  publication_id TEXT,
  source_revision_id TEXT NOT NULL,
  basis_epoch INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL DEFAULT 'molan.memory-proposal/v1',
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'extracting', 'proposed', 'accepted', 'rejected', 'stale', 'failed')
  ),
  summary TEXT NOT NULL DEFAULT '',
  operations_json TEXT NOT NULL DEFAULT '[]',
  decision_json TEXT,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_proposals_book ON memory_proposals(book_id, status, created_at);
CREATE TABLE IF NOT EXISTS story_fact_sets (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  publication_id TEXT,
  source_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'invalidated')),
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_facts (
  id TEXT PRIMARY KEY,
  fact_set_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  predicate TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL DEFAULT '{}',
  evidence_quote TEXT NOT NULL DEFAULT '',
  source_revision_id TEXT NOT NULL,
  publication_id TEXT,
  effective_from_chapter INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_operation_results (
  book_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(book_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS story_outbox (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'obsolete')
  ),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS story_outbox_status ON story_outbox(status, next_run_at);

CREATE TABLE IF NOT EXISTS hook_events (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_stable_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('planned', 'planted', 'developed', 'paid_off', 'abandoned')
  ),
  description TEXT NOT NULL DEFAULT '',
  planned_payoff_chapter INTEGER,
  source_revision_id TEXT,
  publication_id TEXT,
  evidence_quote TEXT NOT NULL DEFAULT '',
  effective_chapter INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hook_events_book ON hook_events(book_id, hook_stable_id, effective_chapter);
CREATE INDEX IF NOT EXISTS hook_events_pub ON hook_events(publication_id);

CREATE TABLE IF NOT EXISTS story_knowledge_events (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('author', 'reader', 'character')),
  character_id TEXT,
  revealed_at_chapter INTEGER NOT NULL,
  source_revision_id TEXT,
  publication_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS story_knowledge_events_book ON story_knowledge_events(book_id, audience, revealed_at_chapter);
CREATE INDEX IF NOT EXISTS story_knowledge_events_fact ON story_knowledge_events(fact_id);

CREATE TABLE IF NOT EXISTS bible_card_revisions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bible_card_revisions_card ON bible_card_revisions(card_id, created_at);

CREATE TABLE IF NOT EXISTS story_batches (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  from_chapter INTEGER,
  to_chapter INTEGER,
  current_chapter INTEGER,
  config_json TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  cost_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS story_batches_book ON story_batches(book_id, created_at);
`);
  const g3FactCols = [
    ["kind", "TEXT NOT NULL DEFAULT 'generic'"],
    ["audience", "TEXT NOT NULL DEFAULT 'author'"],
    ["character_id", "TEXT"],
  ] as const;
  for (const [name, type] of g3FactCols) {
    try {
      run(`ALTER TABLE story_facts ADD COLUMN ${name} ${type}`);
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
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
  ALTER TABLE writing_jobs ADD COLUMN IF NOT EXISTS lease_until TEXT;
  ALTER TABLE scene_routes ADD COLUMN IF NOT EXISTS thinking_intensity TEXT NOT NULL DEFAULT 'medium';
  ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS source_revision_id TEXT;
  ALTER TABLE story_facts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generic';
  ALTER TABLE story_facts ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'author';
  ALTER TABLE story_facts ADD COLUMN IF NOT EXISTS character_id TEXT;
EXCEPTION WHEN others THEN NULL;
END $$;
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
CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT '',
  chapter_number INTEGER,
  mode TEXT NOT NULL DEFAULT 'legacy_current',
  rendered_text TEXT NOT NULL,
  rendered_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  generation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_snapshots_book ON context_snapshots(book_id, created_at);

CREATE TABLE IF NOT EXISTS story_book_heads (
  book_id TEXT PRIMARY KEY,
  story_epoch INTEGER NOT NULL DEFAULT 0 CHECK (story_epoch >= 0),
  fact_set_version INTEGER NOT NULL DEFAULT 0 CHECK (fact_set_version >= 0),
  protocol_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapter_publications (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  body_revision_id TEXT NOT NULL,
  publication_version INTEGER NOT NULL CHECK (publication_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  memory_state TEXT NOT NULL CHECK (
    memory_state IN ('pending', 'proposed', 'ready', 'failed', 'needs_review')
  ),
  accepted_at TEXT NOT NULL,
  accepted_by TEXT NOT NULL DEFAULT 'author'
);
CREATE UNIQUE INDEX IF NOT EXISTS chapter_publications_version
  ON chapter_publications(book_id, chapter_id, publication_version);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_publication_per_chapter
  ON chapter_publications(book_id, chapter_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS chapter_publications_book
  ON chapter_publications(book_id, status);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  publication_id TEXT,
  source_revision_id TEXT NOT NULL,
  basis_epoch INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL DEFAULT 'molan.memory-proposal/v1',
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'extracting', 'proposed', 'accepted', 'rejected', 'stale', 'failed')
  ),
  summary TEXT NOT NULL DEFAULT '',
  operations_json TEXT NOT NULL DEFAULT '[]',
  decision_json TEXT,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_proposals_book ON memory_proposals(book_id, status, created_at);
CREATE TABLE IF NOT EXISTS story_fact_sets (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  publication_id TEXT,
  source_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'invalidated')),
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_facts (
  id TEXT PRIMARY KEY,
  fact_set_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  predicate TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL DEFAULT '{}',
  evidence_quote TEXT NOT NULL DEFAULT '',
  source_revision_id TEXT NOT NULL,
  publication_id TEXT,
  effective_from_chapter INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_operation_results (
  book_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(book_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS story_outbox (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'obsolete')
  ),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS story_outbox_status ON story_outbox(status, next_run_at);

CREATE TABLE IF NOT EXISTS hook_events (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  hook_stable_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('planned', 'planted', 'developed', 'paid_off', 'abandoned')
  ),
  description TEXT NOT NULL DEFAULT '',
  planned_payoff_chapter INTEGER,
  source_revision_id TEXT,
  publication_id TEXT,
  evidence_quote TEXT NOT NULL DEFAULT '',
  effective_chapter INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hook_events_book ON hook_events(book_id, hook_stable_id, effective_chapter);
CREATE INDEX IF NOT EXISTS hook_events_pub ON hook_events(publication_id);

CREATE TABLE IF NOT EXISTS story_knowledge_events (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('author', 'reader', 'character')),
  character_id TEXT,
  revealed_at_chapter INTEGER NOT NULL,
  source_revision_id TEXT,
  publication_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS story_knowledge_events_book ON story_knowledge_events(book_id, audience, revealed_at_chapter);
CREATE INDEX IF NOT EXISTS story_knowledge_events_fact ON story_knowledge_events(fact_id);

CREATE TABLE IF NOT EXISTS bible_card_revisions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bible_card_revisions_card ON bible_card_revisions(card_id, created_at);

CREATE TABLE IF NOT EXISTS story_batches (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  from_chapter INTEGER,
  to_chapter INTEGER,
  current_chapter INTEGER,
  config_json TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  cost_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS story_batches_book ON story_batches(book_id, created_at);
`);
}
