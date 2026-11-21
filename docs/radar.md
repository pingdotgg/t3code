# Upstream Radar (`t3code`, `threadbear`, `rune`)

The Upstream Radar lets a solo developer selectively track and borrow high-value improvements from upstream **T3 Code** (`pingdotgg/t3code`), **Threadbear** (`mikecann/threadbear`), and **Rune** (`anomalyco/rune`) without ever doing painful full-repo merges.

Every digest is filtered through the locked cutlist in [`docs/scope.md`](./scope.md) and routed cleanly into the right component (**Orbit**, **`conn-server`**, **`conn-gpui`**, or future **SwiftUI iOS**).

---

## Quick Usage

```sh
# 1. Fetch upstream refs into gitignored `.refs/` and print commits since references.pin
scripts/radar.sh

# Narrow to one repo or adjust commit limit
scripts/radar.sh --repo t3code --limit 60
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
Run `scripts/radar.sh` in `/Users/nckrtl/apps/conn-gpui` and read `docs/scope.md`.
For every new commit since `references.pin` across `t3code`, `threadbear`, and `rune`:
1. Auto-skip anything touching features marked `Drop` in `docs/scope.md` (Clerk/Connect, OAuth/multi-account/usage limits, SnapShot, Guest Share, Telemetry export, Theme Editor, GitLab, AI PR Review Guides, EAS/Simlock, Snooze/Archive shelves, multi-profile browser import).
2. Inspect the diffs of only the remaining interesting commits (`git -C .refs/<repo> show <sha>`).
3. Produce a concise briefing grouped into:
   - **Adopt in `conn-gpui`** (UI, GPUI/AppKit/CEF/alacritty fixes, chat/composer/diff/panel improvements)
   - **Adopt in `conn-server`** (agent engine, claude/codex/acp drivers, git/files, GitHub PRs, Vault/credentials, annotations, device streaming, Operator voice bridge)
   - **Adopt in Orbit** (workspaces, profiles, themes, tasks, schedules, node routing)
   - **Ideas for future SwiftUI iOS** (mobile UX patterns worth saving)
   - **Auto-skipped count** (one-line summary of what was filtered out)
4. Do NOT edit code or bump `references.pin` yet — wait for Nick to pick which items to port and confirm `--bump`.
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
