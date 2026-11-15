# Continuum IDE architecture

Continuum IDE is T3 Code's architecture with a fork layer on top. Upstream's documents in
[internals/](./internals/overview.md) and [orchestration-v2/](./orchestration-v2/README.md) remain
accurate for the shared core; this page covers how the fork is put together.

## Processes

```
Desktop app (Electron main)            apps/desktop
 ├─ window, menus, updates, IPC, transparency
 ├─ starts the local server ────────▶  Server (Node)          apps/server
 │                                      ├─ orchestration (event-sourced, SQLite)
 │                                      ├─ provider adapters → agent CLIs (Claude Code, Codex, Antigravity, …)
 │                                      ├─ git, worktrees, checkpoints, terminals, browser automation
 │                                      └─ WebSocket RPC + HTTP
 └─ renderer: React app ◀── RPC ──▶     apps/web (also served to browsers and paired devices)
```

Clients never talk to agents directly. They send typed commands (`packages/contracts`) over
WebSocket; the server's orchestrator decides events, commits them with their projections, and an
effect worker runs side effects such as starting a provider turn. Each turn ends with a hidden git
checkpoint so the UI can diff and undo.

## Fork layer

| Concern             | Where                                                                       | Notes                                                                                 |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Identity            | `packages/shared/src/branding.ts`                                           | Name, app ID, data folder, repository URLs. Rebrand by editing this file.             |
| Data isolation      | `DesktopStatePaths.ts`, `os-jank.ts`, `DesktopUserData.ts`                  | `~/.continuum` and `continuum-ide` profiles; never reads `~/.t3`.                     |
| Telemetry           | `apps/server/src/telemetry/AnalyticsService.ts`                             | Off by default; no built-in endpoint.                                                 |
| Window transparency | `apps/desktop/src/window/WindowTransparency.ts`, `WindowOpacitySetting.tsx` | Native `setOpacity` on Windows/macOS; transparent window + renderer opacity on Linux. |
| Packaging           | `scripts/build-desktop-artifact.ts`, `continuum-release.yml`                | Branded artifacts and an update feed pinned to this repository.                       |
| Icons               | `scripts/generate-continuum-icons.mjs`                                      | Generates every desktop and web icon from one vector mark.                            |

Internal identifiers stay upstream-compatible on purpose: package scopes (`@t3tools/*`), environment
variables (`T3CODE_*`), the `t3code://` deep-link scheme used by pairing and the mobile app, and the
`t3` CLI name. Changing them would break the mobile app and every upstream merge.

## Data

| Data                            | Location                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| Threads, projects, settings     | `~/.continuum/userdata/statev2.sqlite`, `settings.json`               |
| Desktop window and client prefs | `~/.continuum/userdata/desktop-settings.json`, `client-settings.json` |
| Logs                            | `~/.continuum/userdata/logs`                                          |
| In-app browser profile          | platform app-data folder `continuum-ide`                              |
| Desktop tokens                  | OS credential store (Keychain, Credential Manager, Secret Service)    |

The database schema and migrations are upstream's and are versioned; see
[internals/legacy-orchestration-migration.md](./internals/legacy-orchestration-migration.md).
