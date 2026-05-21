# Review: Desktop Updates + Release

## Project context

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| **Repository** | `declancowen/t3code`                         |
| **Remote**     | `origin`                                     |
| **Branch**     | `codex/setup-fork-desktop-release`           |
| **Stack**      | TypeScript, Effect, Electron, GitHub Actions |

## Scope

- `.github/workflows/desktop-release.yml` — fork-safe desktop release workflow.
- `apps/desktop/src/window/DesktopApplicationMenu.ts` — manual update-check dialog copy.
- `apps/desktop/src/**/*.test.ts` — menu regression coverage and Electron test shims.
- `apps/web/src/components/PlanSidebar.tsx` and `apps/web/src/components/chat/ChatComposer.tsx` — plan sidebar accent color polish.

## Hotspots

- Stable-only GitHub release behavior matching upstream release/update semantics.
- Local update-track settings accidentally pointing at `nightly` without nightly prereleases in the fork.
- Native menu feedback for manual update checks.
- Release workflow publication permissions, tag/version resolution, artifact upload, and updater manifests.

## Review status

| Field                 | Value                |
| --------------------- | -------------------- |
| **Review started**    | 2026-05-21 12:45 BST |
| **Last reviewed**     | 2026-05-21 12:59 BST |
| **Total turns**       | 2                    |
| **Open findings**     | 0                    |
| **Resolved findings** | 0                    |
| **Accepted findings** | 0                    |

## Turn 2 — 2026-05-21 12:59 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Re-reviewed after the stable-only release clarification and tightened the desktop release workflow to reject prerelease versions entirely.
**Outcome:** All clear.
**Risk score:** Medium — release automation still affects the updater feed and GitHub release metadata.
**Change archetypes:** release automation, updater feed configuration, desktop menu regression coverage, presentation polish.
**Intended change:** Publish only stable desktop releases for the fork and keep the app on the upstream stable updater path.
**Intent vs actual:** The workflow now ignores normal semver prerelease tags, accepts only `x.y.z` / `vx.y.z` in preflight, always publishes `prerelease: false`, and always marks the release as latest. The app code still relies on electron-updater's normal stable behavior instead of mapping GitHub prerelease-feed errors to no-update.
**Confidence:** High for the workflow guard and menu copy; medium for live packaged-app behavior until the installed app is restarted or reinstalled with the updated settings.
**Coverage note:** Current-tree `bun fmt`, `bun lint`, `bun typecheck`, `git diff --check`, and focused desktop updater/menu tests passed. Lint warnings are the existing non-error warnings in unrelated files.
**Finding triage:** No live findings.
**Static/analyzer evidence:** No static-analysis policy changed. Fallow remains unavailable in the repo/PATH.
**Architecture impact:** Stable-vs-nightly ownership is encoded at the release workflow and persisted update-channel setting. No new updater abstraction or provider-specific error bypass was introduced.
**Bug classes / invariants checked:** stable-only version gate rejects prereleases; GitHub release metadata stays non-prerelease/latest; stable update checks use the latest stable release; same-version stable checks surface `up-to-date`; real updater failures remain errors.
**Branch totality:** Rechecked the working tree plus the branch-total release workflow diff against `origin/main`.
**Sibling closure:** Revisited the release workflow preflight/publish jobs, native menu update-check path, desktop update state contract, settings/sidebar update UI paths, and the user-driven primary-color presentation edits.
**Residual risk / unknowns:** A same-version `0.0.25` install can only prove no-update behavior. A later stable release such as `0.0.26` is needed to prove download/install update behavior end to end.

### Validation

- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed, 13 packages.
- `bun run test src/electron/ElectronUpdater.test.ts src/updates/DesktopUpdates.test.ts src/window/DesktopApplicationMenu.test.ts` from `apps/desktop` — passed, 9 tests.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** diff-review gates, all-clear antipatterns, architecture enforcement guidance, desktop release workflow, updater menu tests, updater state consumers.
- **Prior open findings rechecked:** None.
- **Prior resolved/adjacent areas revalidated:** Turn 1 stable/nightly diagnosis still holds; workflow now prevents accidental prerelease publication for this fork.
- **Hotspots or sibling paths revisited:** GitHub release `prerelease`/`make_latest` metadata, tag/version parsing, manual update check dialog, settings/sidebar update button states.
- **Why this is enough:** The branch now encodes stable-only release policy in CI and keeps runtime update behavior aligned with upstream stable electron-updater semantics.

### Resolved / Carried / New findings

- None.

## Turn 1 — 2026-05-21 12:45 BST

| Field           | Value        |
| --------------- | ------------ |
| **Commit**      | working tree |
| **IDE / Agent** | Codex        |

**Summary:** Reviewed the current local diff for stable-only desktop updater setup, native menu copy, release workflow branch state, and plan/sidebar color polish.
**Outcome:** All clear with low-risk unknowns.
**Risk score:** Medium — the workflow affects release publication and the local updater configuration determines whether electron-updater asks GitHub for stable releases or nightly prereleases.
**Change archetypes:** release automation, desktop updater configuration, native menu copy, presentation polish.
**Intended change:** Keep the fork on stable releases only, match upstream stable updater behavior, make the manual update-check success dialog say `No updates available`, and push the latest source changes.
**Intent vs actual:** The diff matches the intent. The app-side special case for GitHub `No published versions on GitHub` was removed so `ElectronUpdater` and `DesktopUpdates` remain aligned with upstream. The local desktop settings were reset from `nightly` to `latest`, which makes electron-updater use the upstream stable path.
**Confidence:** Medium-high — the stable-vs-nightly mismatch was confirmed from local settings and release lists; full repo gates pass. Live packaged-app verification still requires restarting or reinstalling so the running app reloads the settings/source revision.
**Coverage note:** Targeted desktop tests, `bun fmt`, `bun lint`, `bun typecheck`, and `git diff --check` passed. Lint still reports 9 pre-existing warnings outside this diff.
**Finding triage:** No live findings.
**Static/analyzer evidence:** No static-analysis policy changed. Fallow was not available in the repo/PATH, so no Fallow evidence was used.
**Architecture impact:** No new updater abstraction was added. Stable behavior remains owned by electron-updater plus the existing update state reducer; the fork-specific setup is release configuration and local `updateChannel` state, not a provider error workaround.
**Bug classes / invariants checked:** stable track uses GitHub stable latest release; nightly track requires nightly prereleases and is out of scope for this fork; same-version stable release emits the upstream no-update path; real check errors stay retryable check errors; menu check displays the no-update dialog; release workflow keeps write permissions only on the publish job.
**Branch totality:** Reviewed local working changes plus the branch-total diff against `origin/main`, including the existing desktop release workflow commit.
**Sibling closure:** Checked upstream `ElectronUpdater`/`DesktopUpdates`, local desktop settings, fork/upstream release lists, native menu dialog path, settings/sidebar update UI consumers, update status contract, release workflow artifact/manifest publish path, and plan/sidebar presentation-only edits.
**Remediation impact surface:** Desktop settings and menu copy only. No IPC schema, package version script, server/provider runtime, updater state machine, or release asset binary was changed in this turn.
**Residual risk / unknowns:** The currently running app may not reload the edited desktop settings until restart. Same-version `0.0.25` releases are still not a valid end-to-end auto-update download/install test; a later stable version such as `0.0.26` is needed for that.

### Validation

- `bun run test src/electron/ElectronUpdater.test.ts src/updates/DesktopUpdates.test.ts src/window/DesktopApplicationMenu.test.ts` from `apps/desktop` — passed, 9 tests.
- `bun fmt` — passed.
- `bun lint` — passed with 9 existing warnings.
- `bun typecheck` — passed, 13 packages.
- `git diff --check` — passed.

### Branch-totality proof

- **Non-delta files/systems re-read:** diff-review gates, architecture-standards implementation checklist, upstream updater/release files, desktop update UI helpers, native application menu, updater state reducer, IPC update state contract, desktop release workflow.
- **Prior open findings rechecked:** No prior open findings applied to this content area.
- **Prior resolved/adjacent areas revalidated:** The earlier composer steering fix is not changed; the sidebar color edit is presentation-only and does not alter send/runtime behavior.
- **Hotspots or sibling paths revisited:** stable vs nightly update channel selection, settings update check, sidebar update pill/button helpers, GitHub release workflow manifest merge.
- **Dependency/adjacent surfaces revalidated:** `DesktopUpdateState` status contract still carries `up-to-date`; menu copy consumes the existing state; release workflow uses `GITHUB_TOKEN` only in the release job.
- **Why this is enough:** The live issue was traced to a stable/nightly release-channel mismatch, and the repo now avoids adding an app-side workaround that would diverge from upstream behavior.

### Challenger pass

- Not required for Medium risk. The most plausible miss was treating the upstream GitHub provider error as an app bug. The current conclusion is configuration/release-channel mismatch: stable-only forks must keep `updateChannel` on `latest`.

### Resolved / Carried / New findings

- None.

### Recommendations

1. **Fix first:** none.
2. **Then address:** restart the installed app so it reloads `updateChannel: latest`, then check updates again.
3. **Patterns noticed:** if this fork stays stable-only, avoid selecting/publishing nightly channels unless the upstream nightly prerelease pipeline is also adopted.
