//! Background job worker with SQLite lease — parity with Node jobs/worker.ts.

use crate::db::Db;
use crate::error::AppResult;
use crate::services::jobs::{
    DEFAULT_LEASE_TTL_MS, pick_running_job_id, release_job_lease, tick_job, try_acquire_job_lease,
};
use serde_json::{Value, json};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

const DEFAULT_INTERVAL_MS: u64 = 2500;

static WORKER: OnceLock<WorkerHandle> = OnceLock::new();

#[derive(Clone)]
pub struct WorkerHandle {
    inner: Arc<WorkerInner>,
}

struct WorkerInner {
    running: AtomicBool,
    busy: AtomicBool,
    interval_ms: Mutex<u64>,
    last_tick_at: Mutex<Option<String>>,
    last_job_id: Mutex<Option<String>>,
    last_advanced: Mutex<Option<bool>>,
    last_error: Mutex<Option<String>>,
    ticks: Mutex<u64>,
    lease_owner: String,
    locked: Mutex<std::collections::HashSet<String>>,
}

impl WorkerHandle {
    fn new() -> Self {
        let owner = format!(
            "worker-{}-{}",
            std::process::id(),
            &Uuid::new_v4().to_string()[..8]
        );
        Self {
            inner: Arc::new(WorkerInner {
                running: AtomicBool::new(false),
                busy: AtomicBool::new(false),
                interval_ms: Mutex::new(DEFAULT_INTERVAL_MS),
                last_tick_at: Mutex::new(None),
                last_job_id: Mutex::new(None),
                last_advanced: Mutex::new(None),
                last_error: Mutex::new(None),
                ticks: Mutex::new(0),
                lease_owner: owner,
                locked: Mutex::new(std::collections::HashSet::new()),
            }),
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "running": self.inner.running.load(Ordering::SeqCst),
            "intervalMs": *self.inner.interval_ms.lock().unwrap(),
            "busy": self.inner.busy.load(Ordering::SeqCst),
            "lastTickAt": self.inner.last_tick_at.lock().unwrap().clone(),
            "lastJobId": self.inner.last_job_id.lock().unwrap().clone(),
            "lastAdvanced": *self.inner.last_advanced.lock().unwrap(),
            "lastError": self.inner.last_error.lock().unwrap().clone(),
            "ticks": *self.inner.ticks.lock().unwrap(),
            "leaseOwner": self.inner.lease_owner,
            "backend": "rust",
        })
    }

    pub fn lease_owner(&self) -> String {
        self.inner.lease_owner.clone()
    }

    pub async fn with_job_lock(
        &self,
        db: &Db,
        job_id: &str,
        owner: &str,
        f: impl std::future::Future<Output = AppResult<Value>>,
    ) -> Result<Value, LockOutcome> {
        {
            let locked = self.inner.locked.lock().unwrap();
            if locked.contains(job_id) {
                return Err(LockOutcome::Locked);
            }
        }
        let acquired = try_acquire_job_lease(db, job_id, owner, DEFAULT_LEASE_TTL_MS)
            .map_err(LockOutcome::Err)?;
        if !acquired {
            return Err(LockOutcome::Locked);
        }
        self.inner.locked.lock().unwrap().insert(job_id.to_string());
        let result = f.await;
        self.inner.locked.lock().unwrap().remove(job_id);
        let _ = release_job_lease(db, job_id, owner);
        result.map_err(LockOutcome::Err)
    }

    async fn tick_once(&self, db: &Db) {
        if self.inner.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let owner = self.inner.lease_owner.clone();
        match pick_running_job_id(db) {
            Ok(Some(job_id)) => {
                let result = self
                    .with_job_lock(db, &job_id, &owner, tick_job(db, &job_id))
                    .await;
                *self.inner.last_tick_at.lock().unwrap() = Some(crate::db::now_iso());
                *self.inner.last_job_id.lock().unwrap() = Some(job_id.clone());
                *self.inner.ticks.lock().unwrap() += 1;
                match result {
                    Ok(v) => {
                        let advanced = v.get("advanced").and_then(|x| x.as_bool());
                        *self.inner.last_advanced.lock().unwrap() = advanced;
                        let err = v
                            .get("job")
                            .and_then(|j| j.get("error"))
                            .and_then(|e| e.as_str())
                            .map(|s| s.to_string());
                        *self.inner.last_error.lock().unwrap() = err;
                        if advanced == Some(true) {
                            let status = v
                                .get("job")
                                .and_then(|j| j.get("status"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("?");
                            let stage = v
                                .get("job")
                                .and_then(|j| j.get("currentStage"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("?");
                            let ch = v
                                .get("job")
                                .and_then(|j| j.get("currentChapter"))
                                .and_then(|s| s.as_i64())
                                .unwrap_or(0);
                            tracing::info!("[jobs] tick {job_id} → {status} stage={stage} ch={ch}");
                        }
                    }
                    Err(LockOutcome::Locked) => {}
                    Err(LockOutcome::Err(e)) => {
                        *self.inner.last_error.lock().unwrap() = Some(e.to_string());
                        tracing::error!("[jobs] worker tick failed: {e}");
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                *self.inner.last_error.lock().unwrap() = Some(e.to_string());
                *self.inner.last_tick_at.lock().unwrap() = Some(crate::db::now_iso());
                tracing::error!("[jobs] worker tick failed: {e}");
            }
        }
        self.inner.busy.store(false, Ordering::SeqCst);
    }
}

pub enum LockOutcome {
    Locked,
    Err(crate::error::AppError),
}

pub fn global_worker() -> &'static WorkerHandle {
    WORKER.get_or_init(WorkerHandle::new)
}

pub fn start_job_worker(db: Db) {
    let handle = global_worker().clone();
    if handle.inner.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let interval = *handle.inner.interval_ms.lock().unwrap();
    tracing::info!(
        "[jobs] server worker started (every {}ms) owner={}",
        interval,
        handle.inner.lease_owner
    );
    tokio::spawn(async move {
        handle.tick_once(&db).await;
        let mut ticker = tokio::time::interval(Duration::from_millis(interval));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if !handle.inner.running.load(Ordering::SeqCst) {
                break;
            }
            handle.tick_once(&db).await;
        }
    });
}

pub fn worker_status() -> Value {
    global_worker().status()
}
