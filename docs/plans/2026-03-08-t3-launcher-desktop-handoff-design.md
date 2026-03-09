# T3 Launcher Desktop Handoff Design

Date: 2026-03-08
Status: Validated with user

## Summary

This feature improves the existing `t3` command rather than introducing a second launcher. The goal is to let users open projects from Terminal with `t3 .` or `t3 <path>`, while making that command prefer the T3 Code desktop app when the desktop app is installed. If desktop is not installed, `t3` must keep today's web behavior.

The desktop app should also detect whether the `t3` command is available on the system. If it is missing, the app should show a one-time onboarding modal that offers to install the command globally. The install flow must be cross-platform, ask before updating `PATH`, and never touch Codex CLI logic.

## Validated Product Decisions

- `t3` remains the only canonical command.
- The feature is about the T3 launcher CLI, not Codex CLI.
- The desktop app owns detection of whether `t3` is installed.
- If `t3` is missing, the desktop app shows an install modal.
- Install should be app-managed, not package-manager driven.
- PATH updates should require user confirmation.
- If T3 Code desktop is already running, `t3 <path>` should reuse the existing instance.
- If T3 Code desktop is installed but not running, `t3 <path>` should launch it.
- If desktop is not installed, `t3` must keep today's web/server behavior.
- The design must be cross-platform from the start.

## Architecture

The implementation should split into three cooperating layers.

First, the canonical `t3` launcher contract should live in shared launcher logic, not in two separate products. The existing CLI path should be upgraded so `t3` resolves the requested directory, detects whether T3 Code desktop is installed, and chooses between desktop handoff and the current web behavior. That keeps the command contract unified even if the command is installed from different entrypoints.

Second, the desktop app needs a launcher manager. This desktop-side service should detect whether `t3` exists, whether it is app-managed, whether its install directory is on `PATH`, and whether it can be repaired or installed. The install action should create a thin app-managed shim named `t3`, plus any platform-specific helper files needed to invoke the canonical launcher behavior.

Third, the desktop app needs a single-instance open-project handoff. The launcher must be able to start the desktop app with a project path, and a running desktop instance must be able to accept the request, focus its window, and open or reuse the target project.

## Cross-Platform Launcher Install

The app-managed install should place `t3` into an app-owned bin directory.

- macOS: `~/Library/Application Support/T3 Code/bin/t3` or another stable user-scoped app bin path.
- Linux: `~/.local/share/t3code/bin/t3` or another stable user-scoped app bin path.
- Windows: `%LocalAppData%\\T3Code\\bin\\t3.cmd` and optionally a PowerShell companion shim.

The shim should stay minimal. Its responsibilities are:

- normalize `.` or a provided path to an absolute directory
- locate the T3 Code desktop app install metadata
- invoke the canonical `t3` launcher behavior
- prefer desktop handoff when desktop is installed
- fall back to today's web behavior when desktop is unavailable

To avoid drift between desktop-installed `t3` and the existing CLI behavior, the launcher decision logic should be shared in-repo. The shim should not invent its own semantics. It should just bridge the user shell into the same `t3` launch contract.

## Desktop Handoff Flow

Desktop handoff should use a real single-instance Electron flow.

The desktop app should register single-instance ownership and accept project-open requests through startup arguments and second-instance events. The launcher should pass the resolved path as a structured argument such as `--open-project=/abs/path`. On macOS, the same path should also be handled correctly if the app is cold-started from Finder-style launch mechanics.

The desktop process should queue incoming open-project requests until the renderer is ready. Once the renderer is hydrated, it should reuse the existing `project.create` and project-focus behavior instead of creating a second project-opening path. If the project already exists, focus its most recent thread. If it does not exist, create it and create or focus its bootstrap thread.

This keeps the launcher feature additive. Terminal launch becomes another entry into the same project model, not a parallel project subsystem.

## Onboarding UX

The desktop app should check launcher health during startup after PATH normalization. If the app detects that `t3` is missing, it should show a modal explaining the value clearly: open projects from Terminal with `t3 .` and `t3 <path>`.

The modal should include:

- primary action: `Install t3 command`
- secondary action: `Not now`
- optional explanatory text about adding the install directory to `PATH`

If install succeeds, the app should show a success toast with a concrete example command. If the install directory is not on `PATH`, the app should present a second confirmation asking whether it may update shell or user PATH configuration. This step must be explicit because PATH modification is platform-sensitive.

The app should not show this modal again once launcher health reports `installed`. If the launcher later becomes missing or corrupted, the app may show a repair-oriented version of the same modal.

## Error Handling

Launcher health should distinguish between at least these states:

- `installed`
- `missing`
- `needs_path_update`
- `install_failed`
- `desktop_handoff_failed`

Error handling rules:

- failed launcher install should not block the rest of the app
- failed PATH update should degrade to manual instructions
- failed desktop handoff should fall back to current web behavior from the `t3` command
- invalid target paths should produce a clear CLI error before any handoff attempt
- no Codex CLI logic should be changed or coupled into this feature

The fallback rule is important: `t3` remains usable even if desktop detection or handoff fails.

## Testing

Tests should cover the feature at three levels.

Launcher manager tests:

- detects missing `t3`
- detects installed app-managed `t3`
- installs platform shims correctly
- reports PATH update requirements accurately

CLI launcher tests:

- `t3 .` resolves the current directory
- `t3 <path>` resolves relative and absolute paths
- prefers desktop when desktop metadata is present
- falls back to web behavior when desktop metadata is absent

Desktop handoff tests:

- cold start with `--open-project`
- second-instance path handoff to an already running app
- renderer receives queued external project-open requests
- existing projects are focused instead of duplicated

## Suggested Implementation Order

1. Extract launcher decision logic so desktop-aware `t3` behavior is centralized.
2. Add desktop single-instance project-open handoff.
3. Add desktop launcher manager and install status detection.
4. Add onboarding modal and PATH consent flow.
5. Add cross-platform tests and documentation.

## Risks

- cross-platform PATH updates are platform-specific and easy to make brittle
- desktop executable discovery must remain stable across packaged installs and updates
- the app-managed `t3` shim must stay behaviorally aligned with the canonical launcher contract
- cold-start handoff and renderer readiness need a queue to avoid dropped project-open requests

## Implementation Readiness

This design is ready for an implementation plan. The main unresolved work is technical decomposition, not product ambiguity.
