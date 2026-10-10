use crate::error::{AppError, AppResult};
use crate::schema::{SCENES, migrate_sqlite, sqlite_schema};
use crate::services::skills::reload_skills;
use rusqlite::{Connection, params};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Db {
    pub conn: Arc<Mutex<Connection>>,
    pub path: PathBuf,
    pub root: PathBuf,
}

impl Db {
    pub fn open(root: PathBuf) -> anyhow::Result<Self> {
        let data_dir = root.join("data");
        std::fs::create_dir_all(&data_dir)?;
        let path = resolve_sqlite_path(&root);
        let conn = Connection::open(&path)
            .map_err(|e| anyhow::anyhow!("open sqlite {}: {e}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(sqlite_schema())?;
        migrate_sqlite(&conn)?;
        seed_routes(&conn)?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            path,
            root,
        };
        if let Err(e) = reload_skills(&db) {
            tracing::warn!("reload skills on boot: {e}");
        }
        Ok(db)
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| AppError::Other(anyhow::anyhow!("db lock poisoned")))?;
        f(&guard)
    }
}

fn resolve_sqlite_path(root: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("MOLAN_SQLITE_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    root.join("data").join("changjuan.sqlite")
}

fn seed_routes(conn: &Connection) -> anyhow::Result<()> {
    for scene in SCENES {
        conn.execute(
            "INSERT INTO scene_routes (scene, provider, model_id, base_url)
             VALUES (?1, 'local', 'local-draft', NULL)
             ON CONFLICT(scene) DO NOTHING",
            params![scene],
        )?;
    }
    Ok(())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
