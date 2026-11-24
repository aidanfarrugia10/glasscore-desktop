//! Local SQLite store (WAL). Everything stays on this machine.
//! Tables: kv (typed JSON settings/documents), tasks, focus, audit.

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::PathBuf;

pub struct Db {
    conn: Mutex<Connection>,
    pub path: PathBuf,
}

const SCHEMA_VERSION: i64 = 1;

impl Db {
    pub fn open(dir: PathBuf) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("glasscore.db");
        // Backup before any migration (BACKUP-02).
        if path.exists() {
            let _ = std::fs::copy(&path, dir.join("glasscore.db.bak"));
        }
        let conn = Connection::open(&path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                project TEXT NOT NULL DEFAULT '',
                priority INTEGER NOT NULL DEFAULT 2,
                status TEXT NOT NULL DEFAULT 'todo',
                due INTEGER,
                estimate_min INTEGER,
                workspace TEXT,
                checklist TEXT NOT NULL DEFAULT '[]',
                recur TEXT,
                created INTEGER NOT NULL,
                completed INTEGER,
                archived INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS focus (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER,
                start INTEGER NOT NULL,
                stop INTEGER,
                elapsed_s INTEGER NOT NULL DEFAULT 0,
                interruptions INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT NOT NULL,
                result TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(k, v) VALUES('schema', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(Self { conn: Mutex::new(conn), path })
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let c = self.conn.lock();
        f(&c).map_err(|e| e.to_string())
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let c = self.conn.lock();
        let s: Option<String> = c
            .query_row("SELECT v FROM kv WHERE k = ?1", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        s.and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn put<T: Serialize>(&self, key: &str, val: &T) -> Result<(), String> {
        let s = serde_json::to_string(val).map_err(|e| e.to_string())?;
        self.with(|c| {
            c.execute(
                "INSERT INTO kv(k, v, updated) VALUES(?1, ?2, ?3)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated",
                params![key, s, now()],
            )
            .map(|_| ())
        })
    }

    pub fn audit(&self, actor: &str, action: &str, target: &str, result: &str) {
        let _ = self.with(|c| {
            c.execute(
                "INSERT INTO audit(ts, actor, action, target, result) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![now(), actor, action, target, result],
            )?;
            // bounded retention: keep the newest 5000 entries
            c.execute(
                "DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0) - 5000 FROM audit)",
                [],
            )
            .map(|_| ())
        });
    }

    pub fn integrity(&self) -> String {
        self.with(|c| c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)))
            .unwrap_or_else(|e| e)
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AuditRow {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub result: String,
}

pub fn audit_list(db: &Db, limit: i64) -> Result<Vec<AuditRow>, String> {
    db.with(|c| {
        let mut st = c.prepare("SELECT id, ts, actor, action, target, result FROM audit ORDER BY id DESC LIMIT ?1")?;
        let rows = st
            .query_map(params![limit], |r| {
                Ok(AuditRow { id: r.get(0)?, ts: r.get(1)?, actor: r.get(2)?, action: r.get(3)?, target: r.get(4)?, result: r.get(5)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}
