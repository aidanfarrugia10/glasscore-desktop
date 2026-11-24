//! Cooling profiles (FANS-04/05/06/07). Curves are evaluated by the elevated helper so
//! fans stay safe even if this UI hangs; here we only store and send profiles.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FanProfile {
    pub mode: String, // auto | fixed | curve
    pub percent: f64,
    pub curve: Vec<[f64; 2]>,
    pub source: String, // cpu | gpu | max
    pub hysteresis: f64,
    pub step_up: f64,
    pub step_down: f64,
    pub min_percent: f64,
}

impl FanProfile {
    pub fn auto() -> Self { Self { mode: "auto".into(), percent: 60.0, curve: vec![], source: "cpu".into(), hysteresis: 3.0, step_up: 8.0, step_down: 3.0, min_percent: 0.0 } }
    pub fn curve(points: &[[f64; 2]], up: f64, down: f64) -> Self {
        Self { mode: "curve".into(), percent: 60.0, curve: points.to_vec(), source: "max".into(), hysteresis: 3.0, step_up: up, step_down: down, min_percent: 0.0 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CoolingProfile {
    pub id: String,
    pub name: String,
    pub default: FanProfile,
    #[serde(default)]
    pub fans: HashMap<String, FanProfile>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CoolingConfig {
    pub active: String,
    pub profiles: Vec<CoolingProfile>,
}

impl Default for CoolingConfig {
    fn default() -> Self {
        Self {
            active: "auto".into(),
            profiles: vec![
                CoolingProfile { id: "auto".into(), name: "Auto (BIOS)".into(), default: FanProfile::auto(), fans: HashMap::new() },
                CoolingProfile { id: "quiet".into(), name: "Quiet".into(), default: FanProfile::curve(&[[35.0, 22.0], [55.0, 32.0], [70.0, 55.0], [82.0, 85.0], [90.0, 100.0]], 4.0, 2.0), fans: HashMap::new() },
                CoolingProfile { id: "balanced".into(), name: "Balanced".into(), default: FanProfile::curve(&[[30.0, 28.0], [50.0, 40.0], [65.0, 60.0], [78.0, 85.0], [88.0, 100.0]], 6.0, 3.0), fans: HashMap::new() },
                CoolingProfile { id: "performance".into(), name: "Performance".into(), default: FanProfile::curve(&[[30.0, 40.0], [50.0, 60.0], [65.0, 80.0], [75.0, 100.0]], 12.0, 4.0), fans: HashMap::new() },
            ],
        }
    }
}

/// Build the helper's `fan.apply` payload for the given controllable fan IDs.
pub fn payload(p: &CoolingProfile, fan_ids: &[String]) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for id in fan_ids {
        let f = p.fans.get(id).unwrap_or(&p.default);
        m.insert(id.clone(), serde_json::json!({
            "mode": f.mode, "percent": f.percent, "curve": f.curve, "source": f.source,
            "hysteresis": f.hysteresis, "stepUp": f.step_up, "stepDown": f.step_down, "minPercent": f.min_percent,
        }));
    }
    serde_json::json!({ "fans": m })
}
