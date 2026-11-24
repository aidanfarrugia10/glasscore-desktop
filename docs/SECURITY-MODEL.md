# Security model

## Processes and privilege

| Component | Runs as | Can do |
|---|---|---|
| `glasscore.exe` (Tauri core + WebView2 UI) | Standard user | Read telemetry, enumerate processes/services/devices, move windows, drive ASUS Aura USB lighting, store data locally |
| `glasscore-broker.exe` (hardware helper) | Administrator, **only when started by the user** (UAC) or by an opt-in elevated logon task | Fan control, hardware sensors, ASUS Aura SDK, start/stop non-protected services, end elevated processes |

## Webview boundary

* Strict CSP: only bundled scripts, no remote content, no `eval`, no frames.
* `freezePrototype` enabled.
* Tauri capabilities: the main window and the dock window get separate capability sets.
* Every system-changing command re-checks the calling window in Rust (`main_only`), so the dock
  can't trigger privileged actions even if compromised.
* File writes from the UI are limited to user-chosen paths with an extension allow-list
  (`.png`, `.md`, `.txt`, `.json`, `.csv`).
* `open_settings` only accepts `ms-settings:` URIs and a fixed list of Windows tools.
* `launch_path` only launches executables the user pinned or saved in a workspace.

## Hardware helper (privileged broker)

* **Transport:** named pipe `glasscore-broker-<session>`, ACL restricted to the launching user.
* **Authentication:** the first message must carry a 192-bit token from
  `%LOCALAPPDATA%\GlassCore\broker.token` (user profile ACL), compared in constant time.
* **Allow-list:** `ping`, `hw.snapshot`, `fan.apply`, `fan.release`, `aura.devices`, `aura.set`,
  `aura.release`, `svc.control`, `svc.starttype`, `proc.kill`, `task.helper`, `shutdown`.
  Anything else is rejected. No command executes arbitrary programs, writes arbitrary files or
  edits the registry.
* **Protected targets:** core Windows services (RPC, LSA, Defender, firewall, Event Log, …) and
  critical processes (csrss, lsass, winlogon, …) are refused even when elevated.
* **PID reuse:** process termination verifies the process creation time captured when the user
  chose the target.
* **Audit:** every operation is appended to `%LOCALAPPDATA%\GlassCore\broker-audit.log`; the app
  keeps its own audit table for user and rule actions.

Known limitation: any code already running as the same user can read the token file. That code
could already control the user's session, so the helper's allow-list — not the token — is the
real security boundary.

## Fan safety invariants (enforced in the helper, not the UI)

1. Only PWM controls that LibreHardwareMonitor reports as controllable are written.
2. Minimum duty: 30% for CPU / pump / AIO headers, 20% for all others.
3. Curves use hysteresis plus step-up/step-down ramp limits.
4. A fan whose temperature source goes stale for more than 10 s returns to BIOS control.
5. CPU or GPU ≥ 90 °C → every managed fan to 100% until it drops below 85 °C.
6. Client disconnect, 15 s without a ping, crash or exit → all fans return to BIOS control.

## Lighting

* The ASUS Aura USB driver touches only allow-listed product IDs (`0B05:18F3/1939/19AF/1AA6`),
  and only after the firmware and config-table queries return the expected reply headers.
* Only volatile direct-mode colour commands are sent. Nothing is written to controller flash.
* An OEM ownership conflict (Armoury Crate LightingService, OpenRGB, iCUE…) is detected and shown
  before the user decides who owns the lights.

## Data

See [PRIVACY.md](PRIVACY.md).
