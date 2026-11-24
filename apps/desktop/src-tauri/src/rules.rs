//! Event automation (FR-10): trigger -> conditions -> actions, with dry-run,
//! cooldown, per-minute cap, cycle prevention, kill switch and an audit trail.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    ProcessStarted { name: String },
    ProcessExited { name: String },
    ForegroundApp { name: String },
    CpuTempAbove { celsius: f32, seconds: u32 },
    CpuLoadAbove { percent: f32, seconds: u32 },
    GpuLoadAbove { percent: f32, seconds: u32 },
    Time { at: String, days: Vec<u8> }, // "HH:MM", 0=Sun..6=Sat (empty = every day)
    Idle { minutes: u32 },
    TaskStarted,
    TaskCompleted,
    NewListeningPort,
    Startup,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Condition {
    TimeBetween { from: String, to: String },
    ProcessRunning { name: String },
    ProcessNotRunning { name: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    SetLighting { preset: String },
    FlashLighting { color: String },
    LightingBrightness { percent: u8 },
    SetCooling { profile: String },
    ActivateWorkspace { id: String },
    Notify { title: String, body: String },
    SetVolume { percent: u8 },
    Mute { muted: bool },
    GamingMode { on: bool },
    StartFocus,
    StopFocus,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
    #[serde(default = "cd")]
    pub cooldown_s: u32,
    #[serde(default = "mpm")]
    pub max_per_min: u32,
    #[serde(default)]
    pub dry_run: bool,
}
fn cd() -> u32 { 30 }
fn mpm() -> u32 { 3 }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct RuleStats {
    pub fired: u64,
    pub failed: u64,
    pub last: Option<i64>,
    pub last_result: String,
    #[serde(skip)]
    pub recent: VecDeque<i64>,
    #[serde(skip)]
    pub since: Option<i64>, // condition-held-since for duration triggers
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RulesConfig {
    pub enabled: bool, // global kill switch (AUTOMATION-07)
    pub rules: Vec<Rule>,
}

impl Default for RulesConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            rules: vec![
                Rule {
                    id: "thermal-guard".into(), name: "Thermal guard".into(), enabled: true,
                    trigger: Trigger::CpuTempAbove { celsius: 85.0, seconds: 20 }, conditions: vec![],
                    actions: vec![
                        Action::Notify { title: "CPU is running hot".into(), body: "Switched to the Performance cooling profile and dimmed lighting.".into() },
                        Action::SetCooling { profile: "performance".into() },
                        Action::LightingBrightness { percent: 30 },
                    ],
                    cooldown_s: 300, max_per_min: 1, dry_run: false,
                },
                Rule {
                    id: "task-done-flash".into(), name: "Celebrate finished tasks".into(), enabled: true,
                    trigger: Trigger::TaskCompleted, conditions: vec![],
                    actions: vec![Action::FlashLighting { color: "#3DDC84".into() }],
                    cooldown_s: 5, max_per_min: 6, dry_run: false,
                },
                Rule {
                    id: "night-dim".into(), name: "Dim lights at night".into(), enabled: false,
                    trigger: Trigger::Time { at: "22:30".into(), days: vec![] }, conditions: vec![],
                    actions: vec![Action::SetLighting { preset: "night".into() }],
                    cooldown_s: 60, max_per_min: 1, dry_run: false,
                },
            ],
        }
    }
}

/// Plain-English explanation used by dry-run and the rule list (AUTOMATION-05).
pub fn explain(r: &Rule) -> String {
    let t = match &r.trigger {
        Trigger::ProcessStarted { name } => format!("when {} starts", name),
        Trigger::ProcessExited { name } => format!("when {} exits", name),
        Trigger::ForegroundApp { name } => format!("when {} comes to the front", name),
        Trigger::CpuTempAbove { celsius, seconds } => format!("when the CPU stays above {:.0} °C for {} s", celsius, seconds),
        Trigger::CpuLoadAbove { percent, seconds } => format!("when CPU load stays above {:.0}% for {} s", percent, seconds),
        Trigger::GpuLoadAbove { percent, seconds } => format!("when GPU load stays above {:.0}% for {} s", percent, seconds),
        Trigger::Time { at, days } => if days.is_empty() { format!("every day at {}", at) } else { format!("at {} on selected days", at) },
        Trigger::Idle { minutes } => format!("after {} min without input", minutes),
        Trigger::TaskStarted => "when a focus session starts".into(),
        Trigger::TaskCompleted => "when a task is completed".into(),
        Trigger::NewListeningPort => "when a new listening port opens".into(),
        Trigger::Startup => "when GlassCore starts".into(),
    };
    let a: Vec<String> = r.actions.iter().map(|a| match a {
        Action::SetLighting { preset } => format!("switch lighting to “{}”", preset),
        Action::FlashLighting { color } => format!("flash the lights {}", color),
        Action::LightingBrightness { percent } => format!("set lighting brightness to {}%", percent),
        Action::SetCooling { profile } => format!("apply the “{}” cooling profile", profile),
        Action::ActivateWorkspace { id } => format!("activate workspace “{}”", id),
        Action::Notify { title, .. } => format!("show “{}”", title),
        Action::SetVolume { percent } => format!("set volume to {}%", percent),
        Action::Mute { muted } => if *muted { "mute audio".into() } else { "unmute audio".into() },
        Action::GamingMode { on } => if *on { "enter gaming mode".into() } else { "leave gaming mode".into() },
        Action::StartFocus => "start a focus session".into(),
        Action::StopFocus => "stop the focus session".into(),
    }).collect();
    format!("{}, {}.", capitalize(&t), a.join(", then "))
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

pub fn hhmm_now() -> (String, u8) {
    let n = chrono::Local::now();
    (n.format("%H:%M").to_string(), n.format("%w").to_string().parse().unwrap_or(0))
}

pub fn time_between(from: &str, to: &str) -> bool {
    let (now, _) = hhmm_now();
    if from <= to { now.as_str() >= from && now.as_str() < to } else { now.as_str() >= from || now.as_str() < to }
}

/// Rate limiting (AUTOMATION-06). Returns Err(reason) if the rule may not fire now.
pub fn may_fire(r: &Rule, s: &mut RuleStats, now: i64) -> Result<(), String> {
    if let Some(l) = s.last {
        if now - l < r.cooldown_s as i64 { return Err("cooldown".into()); }
    }
    while s.recent.front().map(|t| now - t > 60).unwrap_or(false) { s.recent.pop_front(); }
    if s.recent.len() as u32 >= r.max_per_min.max(1) { return Err("per-minute cap".into()); }
    Ok(())
}
