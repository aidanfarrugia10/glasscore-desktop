# GlassCore

A local-first Windows 11 desktop command centre with a glass interface: ultrawide window
zones, system observability, RGB lighting and fan control, tasks and user-approved automation.
No account, no cloud, no telemetry.

> Status: **0.1 preview.** Core modules work end to end; see [docs/FEATURES.md](docs/FEATURES.md)
> for exactly what is implemented versus planned.

## What's inside

| Section | What it does |
|---|---|
| **Home** | Live CPU / GPU / memory / network / disk, focus timer, one-click lighting & cooling, workspaces, recent activity |
| **Workspace** | Zone layouts for any monitor (built for 5120×1440), custom zone designer, hotkey snapping, saved workspaces that restore windows and launch apps, floating glass dock |
| **Activity** | Process tree with safe end task / suspend / priority / affinity and signature checks; performance graphs with spike markers; network adapters, connections, listening ports and connectivity checks |
| **System** | Retro-modern System Properties, services (dependents shown before stop), device tree with problem codes, startup items, installed apps, Event Log, sessions, redacted diagnostic report |
| **Studio** | 3D model of the PC with per-fan colour picking; ASUS Aura USB / Aura SDK / OpenRGB lighting; effects; LED mapping wizard; fan curves with hysteresis and ramp limits; audio mixer and DDC/CI brightness |
| **Flow** | Tasks (today/upcoming/backlog/board, recurring, checklists, workspace links), focus & Pomodoro with stats, automation rules with dry run and kill switch, clipboard history, snippets, screenshots with annotation and redaction |
| **Settings** | Glass/Mica/solid themes, accent, radius, density, reduced motion, high contrast, start with Windows, hotkeys, privacy & permissions, portable backup |

## Architecture

```
apps/desktop      Tauri v2 (Rust core agent) + SolidJS UI — runs as a standard user
apps/broker       On-demand elevated hardware helper (C#/.NET 8 + LibreHardwareMonitor)
docs/             Security model, signing, feature matrix
```

* The **core agent** (Rust) owns telemetry, processes, network, services, devices, window
  management, lighting, tasks (SQLite/WAL) and the automation engine.
* The **hardware helper** only starts when you ask for fan control or another admin-only
  action. It accepts a fixed allow-list of commands over a per-user named pipe, evaluates fan
  curves itself, and returns every fan to BIOS control if GlassCore exits, crashes or goes quiet.
* Lighting on ASUS Aura USB controllers needs **no** admin rights.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## Build

Requirements: Windows 11, Rust (MSVC), Node 20+, .NET 8 SDK, WebView2.

```powershell
# hardware helper
cd apps/broker
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o publish

# desktop app
cd ../desktop
npm install
npx tauri build
```

Tip: if your checkout path is very long, set `CARGO_TARGET_DIR` to a short folder to stay under
Windows' 260-character path limit.

## Fan control prerequisites

Fan speed control talks to the motherboard's Super I/O chip through LibreHardwareMonitor, which
requires the signed [PawnIO](https://pawnio.eu/) driver. Without it, GlassCore still shows what it
can and never pretends a fan is controllable. If Armoury Crate (or another OEM tool) is running,
GlassCore shows an ownership warning and lets you pause the OEM lighting service.

## Code signing

Release builds are signed through the SignPath Foundation's free programme for open-source
projects — see [docs/SIGNING.md](docs/SIGNING.md).

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## Licence

MIT — see [LICENSE](LICENSE). Third-party components keep their own licences
(LibreHardwareMonitor is MPL-2.0).
