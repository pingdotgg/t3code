# Upstream Radar (`t3code`, `threadbear`, `rune`)

The Upstream Radar lets a solo developer selectively track and borrow high-value improvements from upstream **T3 Code** (`pingdotgg/t3code`), **Threadbear** (`mikecann/threadbear`), and **Rune** (`anomalyco/rune`) without ever doing painful full-repo merges.

Every digest is filtered through the locked cutlist in [`docs/scope.md`](./scope.md) and routed cleanly into the right component (**Orbit**, **`conn-server`**, **`conn-gpui`**, or the SwiftUI iOS app in **`apps/ios`**).

The radar looks for **fixes** as well as features. The Conn Server, conn-gpui and the iOS app are our own code, so an upstream fix never reaches them by a merge. A security, data-loss or provider-protocol fix in code that Conn copied must be found and ported like a feature. `scripts/radar.sh` lists security and data-loss fixes first and in full, then the other likely fixes, apart from the commit list, so its limit hides neither.

---

## Quick Usage

Run these from `apps/conn-gpui`.

```sh
# 1. Fetch upstream refs into gitignored `.refs/` and print commits since references.pin
scripts/radar.sh

# Narrow to one repo or adjust the commit and fix limits
scripts/radar.sh --repo t3code --limit 60 --fix-limit 400
scripts/radar.sh --repo threadbear

# Inspect a specific interesting commit in full without leaving conn-gpui
git -C .refs/t3code show <sha>
git -C .refs/threadbear show <sha>

# 2. After reviewing a digest, advance the pin so next week starts clean
scripts/radar.sh --bump t3code
scripts/radar.sh --bump-all
```

> **Adding a new inspiration repo later:** Add `<name>=<sha>` to `references.pin` and one `"<name>|<git_url>|blobless"` line to `RADAR_REPOS` in `scripts/radar.sh`.

---

## Agent Triage Prompt (On-Demand or `/schedule`)

Run this prompt manually (or put it on a weekly `/schedule`) to get a 2-minute solo-dev briefing:

```text
Work in `apps/conn-gpui` of a fresh `nckrtl/conn` checkout on `origin/main`. Run `scripts/radar.sh` and read `docs/scope.md`.
For every new commit since `references.pin` across `t3code`, `threadbear`, and `rune`:
1. Fixes first. Read every commit under "Security and data-loss fixes". Scan "Other likely fixes" for provider-protocol changes (Claude Agent SDK, Codex app-server, ACP, provider CLI arguments and output) and for crashes or lost work. For each one, find the Conn code that copied or ports the same logic:
   - T3 `apps/server`, `packages/contracts` → `apps/conn-server` (contract changes: `conn-contract`)
   - T3 `apps/web`, `apps/desktop`, `packages/client-runtime` → `apps/conn-gpui` (shared logic: `conn-state`, `conn-client`)
   - T3 `apps/mobile` → `apps/ios`
   - Threadbear `desktop/` and Rune → `apps/conn-gpui`; Threadbear `ios/` → `apps/ios`
   Check whether Conn already has the fix (read the Conn code, and `git log` of that folder). Drop a fix only when Conn has no such code, Conn already has the fix, or the feature is `Drop` in `docs/scope.md`.
2. Auto-skip features marked `Drop` in `docs/scope.md` (Clerk/Connect, OAuth/multi-account/usage limits, SnapShot, Guest Share, Telemetry export, Theme Editor, GitLab, AI PR Review Guides, EAS/Simlock, Snooze/Archive shelves, multi-profile browser import).
3. Inspect the diffs of only the remaining interesting commits (`git -C .refs/<repo> show <sha>`).
4. Produce a concise briefing grouped into:
   - **Fixes to port** (security and data loss first; for each: the upstream commit, what goes wrong without it, and the Conn file that needs it)
   - **Adopt in `conn-gpui`** (UI, GPUI/AppKit/CEF/alacritty fixes, chat/composer/diff/panel improvements)
   - **Adopt in `conn-server`** (agent engine, claude/codex/acp drivers, git/files, GitHub PRs, Vault/credentials, annotations, device streaming, Operator voice bridge)
   - **Adopt in `apps/ios`** (T3 mobile changes the SwiftUI app should follow, and Threadbear iPhone ideas)
   - **Adopt in Orbit** (workspaces, profiles, themes, tasks, schedules, node routing)
   - **Auto-skipped count** (one-line summary of what was filtered out)
5. Do NOT edit code or bump `references.pin` yet — wait for Nick to pick which items to port and confirm `--bump`.
```

---

## Phase 2: One-Time Feature Mining Backlog (Threadbear & Rune)

Once `conn-gpui` + `conn-server` are trimmed to `docs/scope.md`, run a one-time mining pass over `.refs/threadbear` and `.refs/rune` for high-leverage UX ideas to borrow cleanly:

- **From Threadbear (`.refs/threadbear`):**
  - **Decisions / Options review UX** (`docs/readme/decisions.gif`, `docs/readme/options.gif`) — structured multi-choice ask cards & side-by-side design comparison.
  - **Highlights / Pinning** — pinning files, diffs, and previews beside a thread.
  - **Inbox-zero thread lifecycle** — crisp separation of threads needing input vs. running vs. settled.
  - **GPUI/macOS craft** (`desktop/vendor/`, `desktop/gpui/src/`) — popup menus, soft-wrap selection, file drag-and-drop, scroll bounce, and `alacritty_terminal` / CEF polish.
- **From Rune (`.refs/rune`):**
  - **`research/` notes** — GPUI text, scrolling, motion, and frame-pacing performance findings.
  - **Coding-agent UX patterns** (`rune-kit`) — frosted glass tokens, tool-call presentation, and agent-verification workflows.
