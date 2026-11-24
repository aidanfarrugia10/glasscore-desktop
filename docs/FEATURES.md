# Feature matrix (v0.1)

Traceability against the requirement IDs of the product specification. ✅ implemented ·
🟡 partial · ⏳ planned. Hardware features depend on what the device exposes; GlassCore disables
and explains anything unsupported instead of pretending.

## Navigation

The specification's 14–26 page navigation is merged into 7 sections: Home, Workspace, Activity,
System, Studio, Flow, Settings (each with 2–6 sub-tabs).

## Shell & widgets
| ID | Status | Notes |
|---|---|---|
| SHELL-01/02 | ✅ | Floating glass dock window + tray companion; Windows taskbar untouched |
| SHELL-03 | ⏳ | Taskbar replacement deliberately not built (see spec §9) |
| SHELL-04 | ✅ | Acrylic / Mica / solid, tint strength, high contrast, reduced motion |
| SHELL-05/07/08 | 🟡 | Running indicators & pins; no hover previews or rich menus yet |
| WIDGET-03/04/07 | ✅ | Home dashboard: telemetry, clock/date, tasks, focus |
| WIDGET-02/09/10 | ⏳ | Slide-out widget drawer and drag-grid layouts |

## Ultrawide window manager & workspaces
| ID | Status | Notes |
|---|---|---|
| G9-01 | ✅ | Per-monitor bounds, work area, DPI |
| G9-02/03 | ✅ | 2/3/4/5/6/8 zones, 25/50/25, 30/40/30, 20/60/20, 60/40, centre + stacks |
| G9-04 | ✅ | Split, merge, numeric zone editing, save custom layouts |
| G9-05 | 🟡 | Hotkey snapping (Ctrl+Alt+1–9, ←/→); no drag-edge overlay yet |
| G9-09/10 | ✅ | Move to next/previous zone; span zones |
| G9-13 | ✅ | Adjustable gaps, DWM border compensation |
| G9-15 | ✅ | Exclusion list + built-in shell exclusions |
| G9-22 | 🟡 | Reports apps that refuse the requested size |
| WORKSPACE-01/02/03 | ✅ | Capture/restore windows (resolution-independent), launch missing apps |
| WORKSPACE-04/11 | ✅ | Switch from Home, tray, palette; undo last restore |
| WORKSPACE-12 | ✅ | Portable export strips absolute user paths |

## Processes, performance, GPU, network
| ID | Status | Notes |
|---|---|---|
| PROCESS-01..04 | ✅ | Tree/grouped/flat, search, sort; end task with confirmation |
| PROCESS-05 | ✅ | New/exited process highlighting and history |
| PROCESS-07/08 | ✅ | Inspector: threads, modules, windows, children, Authenticode signature |
| PROCESS-09/10/11/12 | ✅ | Tree termination preview, graceful close first, suspend/resume, priority & affinity |
| PROCESS-17 | ✅ | Protected-process badges, unsafe actions disabled |
| FR-03 PID reuse | ✅ | Creation-time identity re-verified before every action |
| PERF-01..05 | ✅ | CPU/cores/clock, memory, disk throughput/busy/queue, network, 30 s–10 min ranges |
| PERF-09 | ✅ | CPU spike markers on graphs |
| GPU-01/02/06 | ✅ | Engine utilisation, dedicated/shared memory via PDH |
| GPU-05 | 🟡 | GPU temperature/clocks/power when the helper is running |
| NETWORK-01..04 | ✅ | Adapters, DNS, gateways, TCP/UDP v4/v6 with owning process, listening ports |
| NETWORK-05/11/14 | ✅ | New-connection highlighting, DNS+HTTPS reachability check, scope classification |
| NETWORK-13 | ✅ | "New listening port" automation trigger |
| NETWORK-06 | ⏳ | Per-process bandwidth (needs ETW) |

## System
| ID | Status | Notes |
|---|---|---|
| SERVICES-01..04 | ✅ | List, start/stop/restart (helper for protected rights), dependents preview |
| SERVICES-07/08 | ✅ | Startup type change via helper; unusual executable path badges |
| DEVICES-01/02/05 | ✅ | Grouped tree, problem codes, driver details, Device Manager link |
| SESSIONS-01..04 | ✅ | WTS sessions, state, protocol, current session |
| SYSTEM-01..06/08 | ✅ | Retro tabbed System Properties, inventory, OS/boot/Secure Boot, apps, env, startup |
| SYSTEM-07 / PRIVACY-17 | ✅ | Redacted diagnostic report with preview |
| DIAGNOSTIC-01/03/05/08 | ✅ | Self-check, Event Log reader, startup review, troubleshooting checklists |

## Lighting & cooling
| ID | Status | Notes |
|---|---|---|
| RGB-01/02/03 | ✅ | Controller & zone discovery, colour + brightness, OEM conflict detection |
| RGB-04 | ✅ | OpenRGB SDK client, localhost only, protocol negotiation |
| RGB-05 | ✅ | ASUS Aura USB direct driver (no admin) + Aura SDK via helper |
| RGB-06/07 | ✅ | Static, breathing, pulse, wave, rainbow, cycle, temperature gradient, off; speed |
| RGB-08/09/15 | ✅ | Zone colours, per-fan LED ranges, mapping wizard with Identify, 3D fan-by-fan editor |
| RGB-12 | ✅ | Controller loss → rediscovery; no flash writes |
| RGB-14 | ✅ | Task-completion flash via automation |
| RGB-17/20 | ✅ | Night brightness cap, frame-rate cap |
| FANS-01/02/03 | ✅ | Read-only until helper; only controllable headers; BIOS protections kept |
| FANS-04/05/06/07 | ✅ | Quiet/Balanced/Performance/Auto + custom; curve editor; CPU/GPU/max source; hysteresis & ramps |
| FANS-08 | ✅ | BIOS fallback on exit, crash, stale sensor, watchdog |
| FANS-11 | 🟡 | Stall warning (0 RPM at >35% duty) |

## Audio & displays
| ID | Status | Notes |
|---|---|---|
| AUDIO-01/02/03 | ✅ | Volume, mute, default device switching, per-app mixer, mic level |
| AUDIO-04/05/06 | ✅ | DDC/CI brightness, monitor topology, Settings deep links |

## Productivity & automation
| ID | Status | Notes |
|---|---|---|
| FILES-01 | ✅ | Command palette (Ctrl+K / Ctrl+Alt+Space) for pages, presets, workspaces, windows |
| FILES-03/04 | ✅ | Clipboard history, opt-in, skips password-manager formats and secrets; paste-as transforms |
| FILES-05/06/07 | ✅ | Screen/monitor/window screenshots, annotate + redact, snippets |
| FILES-12 | ✅ | Quick note |
| TODO-01..08 | ✅ | CRUD, views, focus timer, workspace link, recurring tasks |
| TODO-09/11/12 | ✅ | Checklists, board view, 14-day focus stats |
| AUTOMATION-01..07 | ✅ | Typed triggers/conditions/actions, explanations, dry run, cooldown & cap, kill switch, audit |
| AUTOMATION-12 | ✅ | Default thermal-guard rule |

## Privacy, accessibility, backup
| ID | Status | Notes |
|---|---|---|
| PRIVACY-01/02/03/07/08 | ✅ | Least privilege, backend authorisation, strict CSP, protected targets, confirmations |
| PRIVACY-05 | 🟡 | SignPath signing pipeline ready; awaiting programme approval |
| PRIVACY-09/10/11/13 | ✅ | Permissions view, local-only, telemetry pause & purge, audit log |
| ACCESS-01/02/04/05/06 | 🟡 | Keyboard navigation, themes incl. high contrast, reduced motion, tokens, ARIA labels |
| BACKUP-01/02/03/05/09 | ✅ | SQLite WAL, startup backup, portable JSON, hardware IDs stripped, merge on import |

## Not yet built
Taskbar replacement (SHELL-03), widget drawer, ETW traces and per-process bandwidth, firewall
rules, plugin SDK, encrypted backups, OCR and other P3 items.
