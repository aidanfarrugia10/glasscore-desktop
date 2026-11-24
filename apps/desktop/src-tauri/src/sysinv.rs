//! Devices (PnP tree + problem codes), sessions (WTS), system inventory,
//! installed software, startup items and environment â€” all read-only.

use crate::winutil::*;
use serde::Serialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::System::Registry::*;
use windows::Win32::System::RemoteDesktop::*;
use windows::Win32::System::SystemInformation::*;

#[derive(Serialize, Clone)]
pub struct Device {
    pub name: String,
    pub class: String,
    pub manufacturer: String,
    pub instance: String,
    pub hardware_ids: Vec<String>,
    pub driver_version: String,
    pub driver_date: String,
    pub driver_provider: String,
    pub problem: u32,
    pub status: String,
}

unsafe fn prop(set: HDEVINFO, info: &SP_DEVINFO_DATA, p: SETUP_DI_REGISTRY_PROPERTY) -> Vec<String> {
    let mut buf = [0u8; 4096];
    let mut ty = 0u32;
    let mut need = 0u32;
    if SetupDiGetDeviceRegistryPropertyW(set, info, p, Some(&mut ty), Some(&mut buf), Some(&mut need)).is_err() {
        return vec![];
    }
    let w: Vec<u16> = buf[..need as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    w.split(|&c| c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
}

fn problem_text(code: u32) -> &'static str {
    match code {
        0 => "Working properly",
        1 => "Not configured correctly (code 1)",
        3 => "Driver may be corrupted (code 3)",
        10 => "Device cannot start (code 10)",
        12 => "Not enough free resources (code 12)",
        14 => "Restart required (code 14)",
        18 => "Reinstall the drivers (code 18)",
        19 => "Registry configuration damaged (code 19)",
        21 => "Windows is removing this device (code 21)",
        22 => "Device is disabled (code 22)",
        24 => "Not present or not working (code 24)",
        28 => "Drivers not installed (code 28)",
        29 => "Disabled by firmware (code 29)",
        31 => "Not working properly (code 31)",
        32 => "Driver service disabled (code 32)",
        37 => "Driver failed to initialise (code 37)",
        39 => "Driver corrupted or missing (code 39)",
        43 => "Device reported problems (code 43)",
        45 => "Not currently connected (code 45)",
        52 => "Driver signature can't be verified (code 52)",
        _ => "Problem reported by Windows",
    }
}

pub fn devices() -> Vec<Device> {
    let mut out = vec![];
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(None, PCWSTR::null(), None, DIGCF_ALLCLASSES | DIGCF_PRESENT) else { return out };
        let mut i = 0u32;
        loop {
            let mut info = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
            if SetupDiEnumDeviceInfo(set, i, &mut info).is_err() { break; }
            i += 1;
            let mut inst = [0u16; 512];
            let _ = SetupDiGetDeviceInstanceIdW(set, &info, Some(&mut inst), None);
            let name = prop(set, &info, SPDRP_FRIENDLYNAME).into_iter().next()
                .or_else(|| prop(set, &info, SPDRP_DEVICEDESC).into_iter().next())
                .unwrap_or_else(|| "Unknown device".into());
            let class = prop(set, &info, SPDRP_CLASS).into_iter().next().unwrap_or_else(|| "Other".into());
            let driver_key = prop(set, &info, SPDRP_DRIVER).into_iter().next().unwrap_or_default();
            let (mut dv, mut dd, mut dp) = (String::new(), String::new(), String::new());
            if !driver_key.is_empty() {
                let k = format!(r"SYSTEM\CurrentControlSet\Control\Class\{}", driver_key);
                dv = reg_string(HKEY_LOCAL_MACHINE, &k, "DriverVersion").unwrap_or_default();
                dd = reg_string(HKEY_LOCAL_MACHINE, &k, "DriverDate").unwrap_or_default();
                dp = reg_string(HKEY_LOCAL_MACHINE, &k, "ProviderName").unwrap_or_default();
            }
            let (mut status, mut problem) = (CM_DEVNODE_STATUS_FLAGS(0), CM_PROB(0));
            let _ = CM_Get_DevNode_Status(&mut status, &mut problem, info.DevInst, 0);
            let pc = problem.0;
            out.push(Device {
                name,
                class,
                manufacturer: prop(set, &info, SPDRP_MFG).into_iter().next().unwrap_or_default(),
                instance: from_wide(&inst),
                hardware_ids: prop(set, &info, SPDRP_HARDWAREID),
                driver_version: dv,
                driver_date: dd,
                driver_provider: dp,
                problem: pc,
                status: problem_text(pc).into(),
            });
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    out
}

#[derive(Serialize, Clone)]
pub struct Session {
    pub id: u32,
    pub station: String,
    pub user: String,
    pub domain: String,
    pub state: String,
    pub protocol: String,
    pub current: bool,
}

pub fn sessions() -> Vec<Session> {
    let mut out = vec![];
    let current = unsafe {
        let mut sid = 0u32;
        let _ = windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(std::process::id(), &mut sid);
        sid
    };
    unsafe {
        let mut p: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut n = 0u32;
        if WTSEnumerateSessionsW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut p, &mut n).is_err() { return out; }
        for s in std::slice::from_raw_parts(p, n as usize) {
            let q = |c: WTS_INFO_CLASS| -> String {
                let mut b = PWSTR::null();
                let mut len = 0u32;
                if WTSQuerySessionInformationW(Some(WTS_CURRENT_SERVER_HANDLE), s.SessionId, c, &mut b, &mut len).is_ok() {
                    let v = pwstr(b);
                    WTSFreeMemory(b.0 as _);
                    v
                } else { String::new() }
            };
            let mut proto = 0u16;
            {
                let mut b = PWSTR::null();
                let mut len = 0u32;
                if WTSQuerySessionInformationW(Some(WTS_CURRENT_SERVER_HANDLE), s.SessionId, WTSClientProtocolType, &mut b, &mut len).is_ok() {
                    proto = *(b.0 as *const u16);
                    WTSFreeMemory(b.0 as _);
                }
            }
            let state = match s.State {
                WTSActive => "Active", WTSConnected => "Connected", WTSDisconnected => "Disconnected",
                WTSIdle => "Idle", WTSListen => "Listening", WTSReset => "Reset", WTSDown => "Down", WTSInit => "Initialising",
                _ => "Unknown",
            };
            out.push(Session {
                id: s.SessionId,
                station: pwstr(s.pWinStationName),
                user: q(WTSUserName),
                domain: q(WTSDomainName),
                state: state.into(),
                protocol: match proto { 0 => "Console", 1 => "ICA", 2 => "RDP", _ => "Other" }.into(),
                current: s.SessionId == current,
            });
        }
        WTSFreeMemory(p as _);
    }
    out
}

#[derive(Serialize, Clone)]
pub struct Inventory {
    pub os_name: String,
    pub os_version: String,
    pub os_build: String,
    pub os_edition: String,
    pub install_date: String,
    pub boot_mode: String,
    pub secure_boot: Option<bool>,
    pub cpu: String,
    pub cpu_cores: usize,
    pub cpu_threads: usize,
    pub cpu_base_mhz: String,
    pub board_vendor: String,
    pub board_model: String,
    pub bios_vendor: String,
    pub bios_version: String,
    pub bios_date: String,
    pub system_vendor: String,
    pub system_model: String,
    pub ram_total: u64,
    pub gpus: Vec<(String, String, u64)>,
    pub hostname: String,
    pub arch: String,
    pub is_admin: bool,
}

pub fn inventory() -> Inventory {
    let nt = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let bios = r"HARDWARE\DESCRIPTION\System\BIOS";
    let cpu = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0";
    let r = |p: &str, n: &str| reg_string(HKEY_LOCAL_MACHINE, p, n).unwrap_or_default();
    let build = r(nt, "CurrentBuildNumber");
    let ubr = r(nt, "UBR");
    let mut name = r(nt, "ProductName");
    if build.parse::<u32>().unwrap_or(0) >= 22000 {
        name = name.replace("Windows 10", "Windows 11");
    }
    let mut fw = FIRMWARE_TYPE::default();
    let boot = unsafe { if GetFirmwareType(&mut fw).is_ok() { if fw == FirmwareTypeUefi { "UEFI" } else { "Legacy BIOS" } } else { "Unknown" } };
    let sb = reg_string(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled").map(|v| v == "1");
    let mut gpus = vec![];
    let gclass = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    for k in reg_subkeys(HKEY_LOCAL_MACHINE, gclass) {
        if k.len() != 4 { continue; }
        let p = format!(r"{}\{}", gclass, k);
        let desc = r(&p, "DriverDesc");
        if desc.is_empty() { continue; }
        let mem = reg_string(HKEY_LOCAL_MACHINE, &p, "HardwareInformation.qwMemorySize").and_then(|v| v.parse().ok()).unwrap_or(0u64);
        gpus.push((desc, r(&p, "DriverVersion"), mem));
    }
    let (threads, ram) = match sysinfo::System::new() {
        Ok(mut sys) => { sys.refresh_memory(); sys.refresh_cpu_all(); (sys.cpus().len(), sys.total_memory()) }
        Err(_) => (0, 0),
    };
    let install = r(nt, "InstallDate").parse::<i64>().ok()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    Inventory {
        os_name: name,
        os_version: r(nt, "DisplayVersion"),
        os_build: if ubr.is_empty() { build } else { format!("{}.{}", build, ubr) },
        os_edition: r(nt, "EditionID"),
        install_date: install,
        boot_mode: boot.into(),
        secure_boot: sb,
        cpu: r(cpu, "ProcessorNameString").trim().to_string(),
        cpu_cores: sysinfo::System::physical_core_count().unwrap_or(0),
        cpu_threads: threads,
        cpu_base_mhz: r(cpu, "~MHz"),
        board_vendor: r(bios, "BaseBoardManufacturer"),
        board_model: r(bios, "BaseBoardProduct"),
        bios_vendor: r(bios, "BIOSVendor"),
        bios_version: r(bios, "BIOSVersion"),
        bios_date: r(bios, "BIOSReleaseDate"),
        system_vendor: r(bios, "SystemManufacturer"),
        system_model: r(bios, "SystemProductName"),
        ram_total: ram,
        gpus,
        hostname: std::env::var("COMPUTERNAME").unwrap_or_default(),
        arch: std::env::consts::ARCH.into(),
        is_admin: is_admin(),
    }
}

#[derive(Serialize, Clone)]
pub struct App {
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub installed: String,
    pub size_kb: u64,
    pub scope: String,
}

pub fn installed_apps() -> Vec<App> {
    let mut out: Vec<App> = vec![];
    let roots = [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "Machine"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", "Machine (32-bit)"),
        (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "User"),
    ];
    for (root, path, scope) in roots {
        for k in reg_subkeys(root, path) {
            let p = format!(r"{}\{}", path, k);
            let name = reg_string(root, &p, "DisplayName").unwrap_or_default();
            if name.is_empty() || reg_string(root, &p, "SystemComponent").as_deref() == Some("1") { continue; }
            if out.iter().any(|a| a.name == name) { continue; }
            out.push(App {
                name,
                version: reg_string(root, &p, "DisplayVersion").unwrap_or_default(),
                publisher: reg_string(root, &p, "Publisher").unwrap_or_default(),
                installed: reg_string(root, &p, "InstallDate").unwrap_or_default(),
                size_kb: reg_string(root, &p, "EstimatedSize").and_then(|s| s.parse().ok()).unwrap_or(0),
                scope: scope.into(),
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[derive(Serialize, Clone)]
pub struct StartupItem {
    pub name: String,
    pub command: String,
    pub location: String,
    pub enabled: bool,
}

pub fn startup_items() -> Vec<StartupItem> {
    let mut out = vec![];
    let approved = |root: HKEY, sub: &str, name: &str| -> bool {
        // StartupApproved: first byte 0x02/0x06 = enabled, 0x03/0x07 = disabled.
        unsafe {
            let p = wide(&format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\{}", sub));
            let n = wide(name);
            let mut buf = [0u8; 12];
            let mut size = 12u32;
            if RegGetValueW(root, PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()), RRF_RT_REG_BINARY, None, Some(buf.as_mut_ptr() as _), Some(&mut size)).is_ok() {
                return buf[0] & 1 == 0;
            }
            true
        }
    };
    for (root, label) in [(HKEY_CURRENT_USER, "User Run key"), (HKEY_LOCAL_MACHINE, "Machine Run key")] {
        for (n, v) in reg_values(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run") {
            out.push(StartupItem { enabled: approved(root, "Run", &n), name: n, command: v, location: label.into() });
        }
    }
    let folders = [
        std::env::var("APPDATA").map(|a| format!(r"{}\Microsoft\Windows\Start Menu\Programs\Startup", a)).ok(),
        std::env::var("ProgramData").map(|a| format!(r"{}\Microsoft\Windows\Start Menu\Programs\StartUp", a)).ok(),
    ];
    for f in folders.into_iter().flatten() {
        if let Ok(rd) = std::fs::read_dir(&f) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.eq_ignore_ascii_case("desktop.ini") { continue; }
                out.push(StartupItem { enabled: approved(HKEY_CURRENT_USER, "StartupFolder", &n), name: n, command: e.path().to_string_lossy().to_string(), location: "Startup folder".into() });
            }
        }
    }
    out
}

#[derive(Serialize, Clone)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

pub fn environment() -> Vec<EnvVar> {
    let mut v: Vec<EnvVar> = std::env::vars().map(|(name, value)| EnvVar { name, value }).collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}
