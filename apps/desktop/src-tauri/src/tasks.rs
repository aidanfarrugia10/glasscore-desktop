//! Personal tasks and focus sessions (FR-09). Fully offline and transactional.

use crate::db::{now, Db};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub notes: String,
    pub project: String,
    pub priority: i64,
    pub status: String, // todo | active | done
    pub due: Option<i64>,
    pub estimate_min: Option<i64>,
    pub workspace: Option<String>,
    pub checklist: serde_json::Value,
    pub recur: Option<String>,
    pub created: i64,
    pub completed: Option<i64>,
    pub archived: bool,
    pub focused_s: i64,
}

#[derive(Deserialize, Debug)]
pub struct TaskInput {
    pub title: String,
    #[serde(default)] pub notes: String,
    #[serde(default)] pub project: String,
    #[serde(default = "two")] pub priority: i64,
    pub due: Option<i64>,
    pub estimate_min: Option<i64>,
    pub workspace: Option<String>,
    #[serde(default)] pub checklist: Option<serde_json::Value>,
    pub recur: Option<String>,
}
fn two() -> i64 { 2 }

pub fn list(db: &Db, include_archived: bool) -> Result<Vec<Task>, String> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT t.id, t.title, t.notes, t.project, t.priority, t.status, t.due, t.estimate_min, t.workspace, t.checklist, t.recur, t.created, t.completed, t.archived,
                    COALESCE((SELECT SUM(elapsed_s) FROM focus f WHERE f.task_id = t.id), 0)
             FROM tasks t WHERE (?1 OR t.archived = 0) ORDER BY t.status = 'done', t.priority DESC, COALESCE(t.due, 9e18), t.id DESC",
        )?;
        let rows = st.query_map(params![include_archived], |r| {
            let cl: String = r.get(9)?;
            Ok(Task {
                id: r.get(0)?, title: r.get(1)?, notes: r.get(2)?, project: r.get(3)?, priority: r.get(4)?, status: r.get(5)?,
                due: r.get(6)?, estimate_min: r.get(7)?, workspace: r.get(8)?, checklist: serde_json::from_str(&cl).unwrap_or(serde_json::json!([])),
                recur: r.get(10)?, created: r.get(11)?, completed: r.get(12)?, archived: r.get::<_, i64>(13)? != 0, focused_s: r.get(14)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn create(db: &Db, t: TaskInput) -> Result<i64, String> {
    if t.title.trim().is_empty() { return Err("Title can't be empty".into()); }
    db.with(|c| {
        c.execute(
            "INSERT INTO tasks(title, notes, project, priority, due, estimate_min, workspace, checklist, recur, created) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![t.title.trim(), t.notes, t.project, t.priority.clamp(0, 3), t.due, t.estimate_min, t.workspace,
                    t.checklist.unwrap_or(serde_json::json!([])).to_string(), t.recur, now()],
        )?;
        Ok(c.last_insert_rowid())
    })
}

pub fn update(db: &Db, id: i64, t: TaskInput) -> Result<(), String> {
    db.with(|c| c.execute(
        "UPDATE tasks SET title=?2, notes=?3, project=?4, priority=?5, due=?6, estimate_min=?7, workspace=?8, checklist=COALESCE(?9, checklist), recur=?10 WHERE id=?1",
        params![id, t.title.trim(), t.notes, t.project, t.priority.clamp(0, 3), t.due, t.estimate_min, t.workspace, t.checklist.map(|v| v.to_string()), t.recur],
    ).map(|_| ()))
}

pub fn set_status(db: &Db, id: i64, status: &str) -> Result<(), String> {
    let status = match status { "todo" | "active" | "done" => status, _ => return Err("bad status".into()) };
    db.with(|c| {
        let tx = c.unchecked_transaction()?;
        tx.execute("UPDATE tasks SET status=?2, completed=CASE WHEN ?2='done' THEN ?3 ELSE NULL END WHERE id=?1", params![id, status, now()])?;
        // Recurring: completing spawns the next occurrence (TODO-08).
        if status == "done" {
            let r: Option<(String, String, String, i64, Option<i64>, Option<i64>)> = tx.query_row(
                "SELECT recur, title, project, priority, due, estimate_min FROM tasks WHERE id=?1 AND recur IS NOT NULL", params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).ok();
            if let Some((recur, title, project, pri, due, est)) = r {
                let step = match recur.as_str() { "daily" => 86_400, "weekly" => 7 * 86_400, "monthly" => 30 * 86_400, _ => 0 };
                if step > 0 {
                    let next = due.unwrap_or(now()) + step;
                    tx.execute("INSERT INTO tasks(title, project, priority, due, estimate_min, recur, created) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                        params![title, project, pri, next, est, recur, now()])?;
                }
            }
        }
        tx.commit()
    })
}

pub fn archive(db: &Db, id: i64, archived: bool) -> Result<(), String> {
    db.with(|c| c.execute("UPDATE tasks SET archived=?2 WHERE id=?1", params![id, archived as i64]).map(|_| ()))
}

pub fn delete(db: &Db, id: i64) -> Result<(), String> {
    db.with(|c| {
        c.execute("DELETE FROM focus WHERE task_id=?1", params![id])?;
        c.execute("DELETE FROM tasks WHERE id=?1", params![id]).map(|_| ())
    })
}

pub fn postpone(db: &Db, id: i64, days: i64) -> Result<(), String> {
    db.with(|c| c.execute("UPDATE tasks SET due = COALESCE(due, ?2) + ?3 WHERE id=?1", params![id, now(), days * 86_400]).map(|_| ()))
}

// ---- focus sessions (TODO-04/06) ----

#[derive(Serialize, Clone, Debug)]
pub struct Focus {
    pub id: i64,
    pub task_id: Option<i64>,
    pub start: i64,
    pub stop: Option<i64>,
    pub elapsed_s: i64,
    pub interruptions: i64,
}

pub fn focus_start(db: &Db, task_id: Option<i64>) -> Result<i64, String> {
    focus_stop(db)?;
    db.with(|c| {
        c.execute("INSERT INTO focus(task_id, start) VALUES(?1, ?2)", params![task_id, now()])?;
        if let Some(t) = task_id { c.execute("UPDATE tasks SET status='active' WHERE id=?1 AND status='todo'", params![t])?; }
        Ok(c.last_insert_rowid())
    })
}

pub fn focus_stop(db: &Db) -> Result<Option<Focus>, String> {
    let open = focus_current(db)?;
    if let Some(f) = &open {
        let el = now() - f.start;
        db.with(|c| c.execute("UPDATE focus SET stop=?2, elapsed_s=?3 WHERE id=?1", params![f.id, now(), el]).map(|_| ()))?;
    }
    Ok(open.map(|mut f| { f.elapsed_s = now() - f.start; f.stop = Some(now()); f }))
}

pub fn focus_interrupt(db: &Db) -> Result<(), String> {
    db.with(|c| c.execute("UPDATE focus SET interruptions = interruptions + 1 WHERE stop IS NULL", []).map(|_| ()))
}

pub fn focus_current(db: &Db) -> Result<Option<Focus>, String> {
    db.with(|c| {
        let mut st = c.prepare("SELECT id, task_id, start, stop, elapsed_s, interruptions FROM focus WHERE stop IS NULL ORDER BY id DESC LIMIT 1")?;
        let mut rows = st.query_map([], |r| Ok(Focus { id: r.get(0)?, task_id: r.get(1)?, start: r.get(2)?, stop: r.get(3)?, elapsed_s: r.get(4)?, interruptions: r.get(5)? }))?;
        rows.next().transpose()
    })
}

/// Per-day focused minutes for the last N days (TODO-12).
pub fn focus_stats(db: &Db, days: i64) -> Result<Vec<(String, i64, i64)>, String> {
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT date(start, 'unixepoch', 'localtime') d, SUM(elapsed_s)/60, COUNT(*) FROM focus WHERE start >= ?1 AND stop IS NOT NULL GROUP BY d ORDER BY d",
        )?;
        let rows = st.query_map(params![now() - days * 86_400], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}
