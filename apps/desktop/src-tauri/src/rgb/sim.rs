//! Simulated ARGB hub (PLUGIN-08): 4 fans x 16 LEDs on one chain plus a 12 V strip.
//! Lets the lighting studio, mapping wizard and rules be exercised with no hardware.

use super::*;

pub struct Simulated {
    pub frames: Vec<Vec<Rgb>>,
}

impl Simulated {
    pub fn new() -> Self { Self { frames: vec![vec![[0; 3]; 64], vec![[0; 3]; 1]] } }
}

impl Controller for Simulated {
    fn info(&self) -> ControllerInfo {
        ControllerInfo {
            id: "sim-hub".into(),
            name: "Simulated ARGB hub".into(),
            provider: "Developer simulation".into(),
            firmware: "sim-1.0".into(),
            zones: vec![
                ZoneInfo { index: 0, name: "Fan chain".into(), leds: self.frames[0].len(), max_leds: 120, kind: ZoneKind::Addressable, resizable: true },
                ZoneInfo { index: 1, name: "12V strip".into(), leds: 1, max_leds: 1, kind: ZoneKind::Group, resizable: false },
            ],
            notes: vec!["No hardware is changed by this controller.".into()],
        }
    }
    fn set_zone(&mut self, zone: usize, colors: &[Rgb]) -> Result<(), String> {
        let f = self.frames.get_mut(zone).ok_or("No such zone")?;
        *f = colors.to_vec();
        Ok(())
    }
    fn resize_zone(&mut self, zone: usize, leds: usize) -> Result<(), String> {
        if zone != 0 { return Err("Not resizable".into()); }
        self.frames[0] = vec![[0; 3]; leds.clamp(1, 120)];
        Ok(())
    }
}
