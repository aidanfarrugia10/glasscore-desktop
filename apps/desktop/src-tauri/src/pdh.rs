//! Minimal PDH (Performance Data Helper) wrapper for counters sysinfo doesn't cover:
//! GPU engine utilisation, GPU memory and physical-disk throughput/latency.

use windows::core::PCWSTR;
use windows::Win32::System::Performance::*;

const FMT: PDH_FMT = PDH_FMT(PDH_FMT_DOUBLE.0 | 0x8000); // double, no 100% cap

pub struct Pdh {
    query: PDH_HQUERY,
    counters: Vec<(String, PDH_HCOUNTER, bool)>, // name, handle, wildcard
}

unsafe impl Send for Pdh {}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl Pdh {
    pub fn new() -> Option<Self> {
        unsafe {
            let mut q = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
                return None;
            }
            Some(Self { query: q, counters: vec![] })
        }
    }

    pub fn add(&mut self, name: &str, path: &str) {
        unsafe {
            let w = wide(path);
            let mut c = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(self.query, PCWSTR(w.as_ptr()), 0, &mut c) == 0 {
                self.counters.push((name.to_string(), c, path.contains('*')));
            }
        }
    }

    pub fn collect(&self) {
        unsafe {
            let _ = PdhCollectQueryData(self.query);
        }
    }

    /// Single-instance counter value.
    pub fn value(&self, name: &str) -> Option<f64> {
        let (_, c, _) = self.counters.iter().find(|(n, _, w)| n == name && !*w)?;
        unsafe {
            let mut v = PDH_FMT_COUNTERVALUE::default();
            if PdhGetFormattedCounterValue(*c, FMT, None, &mut v) == 0 {
                Some(v.Anonymous.doubleValue)
            } else {
                None
            }
        }
    }

    /// Wildcard counter: (instance name, value) pairs.
    pub fn array(&self, name: &str) -> Vec<(String, f64)> {
        let mut out = vec![];
        let Some((_, c, _)) = self.counters.iter().find(|(n, _, w)| n == name && *w) else { return out };
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            let _ = PdhGetFormattedCounterArrayW(*c, FMT, &mut size, &mut count, None);
            if size == 0 {
                return out;
            }
            let mut buf = vec![0u8; size as usize];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(*c, FMT, &mut size, &mut count, Some(items)) == 0 {
                for i in 0..count as usize {
                    let it = &*items.add(i);
                    let name = it.szName.to_string().unwrap_or_default();
                    out.push((name, it.FmtValue.Anonymous.doubleValue));
                }
            }
        }
        out
    }
}

impl Drop for Pdh {
    fn drop(&mut self) {
        unsafe {
            let _ = PdhCloseQuery(self.query);
        }
    }
}
