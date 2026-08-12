# Desktop tray (macOS menu bar) design

## Goal

A T3 mark in the macOS menu bar. Clicking it shows how many agents are
running, grouped by project, plus quick entries for Open T3 Code, Settings,
Usage, Pull Requests, Check for Updates, and Quit.

## Scope decisions

- **macOS only (v1).** "Menu bar" is a macOS ask; template images and click
  semantics are darwin-specific. Windows/Linux tray support can follow the
  same service split later.
- **Local primary environment only.** Remote/SSH/relay environments need
  per-connection credentials the main process does not hold; the low-risk v1
  counts agents on the bundled local backend
  (`PRIMARY_LOCAL_ENVIRONMENT_ID`).
- **Fetch on click, no background polling.** The ask is "when clicked it
  shows"; the menu is built from a fresh shell snapshot fetched at click
  time (short timeout, falls back to the last good snapshot). No timers, no
  idle network traffic, tray stays correct with every window closed.

## Components

1. `apps/desktop/src/electron/ElectronTray.ts` — thin `Context.Service`
   wrapper over `Electron.Tray` (`create` (scoped, destroys on release),
   `popUpMenu`, `setToolTip`), mirroring `ElectronMenu`'s mockable-surface
   pattern. Registered in `electronLayer` (`main.ts`).
2. `apps/desktop/src/window/trayMenu.ts` — pure menu-model builder:
   `OrchestrationShellSnapshot → TrayMenuModel` (per-project active-agent
   counts + thread rows with phase headlines). Uses the shared
   `projectThreadAwareness` predicate from `@t3tools/shared/agentAwareness`;
   "active" phases are `starting`, `running`, `waiting_for_approval`,
   `waiting_for_input`. Fully unit-tested (`trayMenu.test.ts`).
3. `apps/desktop/src/window/DesktopTray.ts` — orchestrator service
   (`configure`, darwin-gated), registered in `desktopApplicationLayer` and
   invoked from `DesktopApp.startup` next to `applicationMenu.configure`.
   - Icon: `t3TrayTemplate.png` / `@2x` from `apps/desktop/resources/`
     (new, rasterized from the brand T3 mark, black on transparent) via
     `DesktopAssets.resolveResourcePath`; `Template` suffix + explicit
     `setTemplateImage(true)` make macOS recolor it for light/dark bars.
   - Click → fetch shell snapshot (`fetchEnvironmentShellSnapshot` with a
     `PreparedConnection` built from `DesktopBackendPool` primary config +
     `DesktopLocalEnvironmentAuth.getBearerToken`, 2 s timeout) → build
     model → pop up native menu. Fetch failure degrades to the cached
     snapshot or an "Agents unavailable" row; it never blocks the menu.
   - Menu actions reuse existing plumbing: `revealOrCreateMain`,
     `dispatchMenuAction("open-settings" | "open-usage" |
     "open-pull-requests")`, the exported check-for-updates handler from
     `DesktopApplicationMenu` (reason `"tray"`), `electronApp.quit`.
4. `apps/web/src/components/AppSidebarLayout.tsx` — extend the existing
   `desktop:menu-action` listener with `open-usage` (`/usage`) and
   `open-pull-requests` (`/pull-requests` with
   `search: { involvement: "all", state: "open" }`).

## Menu layout

```
Running agents            (disabled header; or "No agents running")
  <Project A — 2 active>  ▸  <thread title — Working…>
  <Project B — 1 active>  ▸  <thread title — Waiting on approval>
──────────────
Open T3 Code
──────────────
Settings…
Usage
Pull Requests
──────────────
Check for Updates…
──────────────
Quit T3 Code
```

## Error handling

- Backend not configured / not started / auth failure → "Agents
  unavailable" disabled row; the static entries always work.
- Bearer token staleness after a backend restart resolves on the next
  successful bootstrap; the tray degrades gracefully in between (known v1
  limitation).
- Tray icon missing → skip tray creation with a logged warning; never
  crash startup.

## Testing

- `trayMenu.test.ts` — grouping, counting, phase labels, empty/unavailable
  states (pure).
- `ElectronTray.test.ts` — wrapper surface with the mocked `electron`
  module, mirroring `ElectronMenu.test.ts`.
- Targeted `vp test run` + typecheck for the touched scope only, per
  AGENTS.md.
