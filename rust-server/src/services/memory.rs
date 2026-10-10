//! Async chapter memory extract — parity with Node scheduleMemoryExtract / waitMemoryExtract.

use crate::db::Db;
use crate::error::AppResult;
use crate::services::engine::{ExecuteSceneInput, artifact_body, execute_scene};
use crate::services::revisions::OnConflict;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

fn memory_key(book_id: &str, chapter_number: i64) -> String {
    format!("{book_id}:{chapter_number}")
}

struct MemoryState {
    desired: HashMap<String, String>,
    /// Outstanding waiters for an in-flight extract.
    waiters: HashMap<String, Vec<oneshot::Sender<()>>>,
    pending: HashMap<String, bool>,
}

fn state() -> &'static Mutex<MemoryState> {
    static STATE: OnceLock<Mutex<MemoryState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(MemoryState {
            desired: HashMap::new(),
            waiters: HashMap::new(),
            pending: HashMap::new(),
        })
    })
}

/// After chapter body is saved/generated, quietly refresh chapter memory ledger.
pub fn schedule_memory_extract(db: Db, book_id: String, chapter_number: i64, source_revision_id: Option<String>) {
    let key = memory_key(&book_id, chapter_number);
    {
        let mut st = state().lock().unwrap();
        if let Some(rev) = source_revision_id.clone().filter(|s| !s.is_empty()) {
            st.desired.insert(key.clone(), rev);
        }
        if st.pending.get(&key).copied().unwrap_or(false) {
            // Already running — desired revision is updated; runner will re-check.
            return;
        }
        st.pending.insert(key.clone(), true);
    }

    let target_rev = {
        let st = state().lock().unwrap();
        st.desired
            .get(&key)
            .cloned()
            .or(source_revision_id)
            .unwrap_or_default()
    };

    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        let mut st = state().lock().unwrap();
        st.pending.remove(&key);
        tracing::warn!("memory extract: no tokio runtime; skipped {key}");
        return;
    };

    handle.spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        let result = execute_scene(
            &db,
            ExecuteSceneInput {
                book_id: book_id.clone(),
                scene: "memory_extract".into(),
                chapter_number: Some(chapter_number),
                instruction: String::new(),
                skill_ids: None,
                expected_revision_id: None,
                on_conflict: OnConflict::Candidate,
                generation_id: None,
                cancelled: None,
                job_id: None,
            source_revision_id: if target_rev.is_empty() {
                    None
                } else {
                    Some(target_rev.clone())
                },
            tools_requested: false,
        },
        )
        .await;
        if let Err(e) = result {
            tracing::error!("[memory] extract failed: {e}");
        }

        let mut reschedule: Option<String> = None;
        {
            let mut st = state().lock().unwrap();
            let latest = st.desired.get(&key).cloned();
            if let (Some(latest), true) = (latest, !target_rev.is_empty()) {
                if latest != target_rev {
                    reschedule = Some(latest);
                }
            }
            st.pending.remove(&key);
            if let Some(waiters) = st.waiters.remove(&key) {
                for w in waiters {
                    let _ = w.send(());
                }
            }
        }

        if let Some(latest) = reschedule {
            schedule_memory_extract(db, book_id, chapter_number, Some(latest));
        }
    });
}

/// Wait until memory extract finishes (or timeout). Returns true if memory exists / done.
pub async fn wait_memory_extract(db: &Db, book_id: &str, chapter_number: i64, timeout_ms: u64) -> bool {
    let key = memory_key(book_id, chapter_number);
    let existing = db
        .with_conn(|conn| Ok(artifact_body(conn, book_id, "chapter_memory", Some(chapter_number))))
        .unwrap_or_default();

    let needs_kick = {
        let st = state().lock().unwrap();
        !st.pending.get(&key).copied().unwrap_or(false)
    };

    if needs_kick {
        if existing.trim().is_empty() {
            let body = db
                .with_conn(|conn| Ok(artifact_body(conn, book_id, "chapter_body", Some(chapter_number))))
                .unwrap_or_default();
            if body.trim().is_empty() {
                return true;
            }
            schedule_memory_extract(db.clone(), book_id.to_string(), chapter_number, None);
        } else {
            // No pending and memory already present.
            let still_pending = {
                let st = state().lock().unwrap();
                st.pending.get(&key).copied().unwrap_or(false)
            };
            if !still_pending {
                return true;
            }
        }
    }

    let rx = {
        let mut st = state().lock().unwrap();
        if !st.pending.get(&key).copied().unwrap_or(false) {
            // Finished between checks.
            drop(st);
            return db
                .with_conn(|conn| Ok(artifact_body(conn, book_id, "chapter_memory", Some(chapter_number))))
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
                || !existing.trim().is_empty();
        }
        let (tx, rx) = oneshot::channel();
        st.waiters.entry(key.clone()).or_default().push(tx);
        rx
    };

    let timed_out = tokio::select! {
        _ = rx => false,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => true,
    };

    if timed_out {
        // Drop waiter is already consumed by timeout; clean stray senders optional.
        let mem = db
            .with_conn(|conn| Ok(artifact_body(conn, book_id, "chapter_memory", Some(chapter_number))))
            .unwrap_or_default();
        return !mem.trim().is_empty();
    }

    let mem = db
        .with_conn(|conn| Ok(artifact_body(conn, book_id, "chapter_memory", Some(chapter_number))))
        .unwrap_or_default();
    !mem.trim().is_empty() || !existing.trim().is_empty()
}
