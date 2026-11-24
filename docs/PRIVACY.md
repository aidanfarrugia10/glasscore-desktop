# Privacy

GlassCore is local-first. It has no account, no cloud service, no analytics and no update
pings. It makes a network connection only when you run a connectivity check against a host you
typed in.

## Stored on disk (`%LOCALAPPDATA%\GlassCore`)

| What | Where | Notes |
|---|---|---|
| Preferences, layouts, workspaces, lighting & cooling profiles, rules | `glasscore.db` (SQLite) | Workspaces store executable paths and window positions |
| Tasks and focus sessions | `glasscore.db` | Deletable per task, or all focus history via *Clear activity data* |
| Activity log (user, rule and helper actions) | `glasscore.db` | Capped at 5,000 rows |
| Helper audit log | `broker-audit.log` | Rotated at 2 MB |
| Helper token | `broker.token` | Random; authenticates the helper connection |
| Startup backup | `glasscore.db.bak` | Copy made before each start/migration |

## Never written to disk

* Performance history (kept in memory for 10 minutes)
* Process command lines, window titles, URLs
* Clipboard history (opt-in, in memory only; password-manager copies and secret-looking text
  are skipped)
* Screenshots are only saved where you choose (`Pictures\Screenshots` by default)

## Exports

Profile exports and diagnostic reports remove your Windows username, PC name, controller IDs and
monitor IDs. You always see a diagnostic report before saving it.
