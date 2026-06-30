---
name: upgrade-t3code
description: |
  Upgrade a private T3 Code fork to the latest upstream while preserving local
  patch intent through PATCH.md. Runs the safe rebase script, then routes any
  conflicts to patch-resolve.
triggers:
  - "upgrade t3code"
  - "update t3code"
  - "upgrade my t3code fork"
  - "update my t3code fork"
  - "run patch upgrade"
  - "bring t3code up to latest"
tools:
  - exec
  - read
mutating: true
---

# Upgrade T3 Code

This skill updates a private/local T3 Code fork without silently discarding
local patch intent.

## Safety model

- `pnpm patch:upgrade` handles Git mechanics.
- `PATCH.md` explains local patch intent.
- `skills/patch-resolve` re-applies conflicting intent after explicit approval.
- The app itself should not be expected to survive its own update. If this is
  launched from inside T3 Code, open an external Codex or Claude Code session
  and run this skill there.

## Workflow

### 1. Preflight

Run:

```sh
git rev-parse --show-toplevel
git branch --show-current
git status --short
git remote -v
git rev-parse --abbrev-ref --symbolic-full-name @{upstream}
```

Stop if the working tree is dirty unless the user explicitly approves committing
or stashing unrelated work. Do not update directly on `main` for private fork
patches; use a patch branch.

### 2. Read patch intent

Read `PATCH.md`. If it is missing, stop and ask whether this fork has local
patches that need a manifest before upgrading.

### 3. Run the safe upgrade

Run:

```sh
pnpm patch:upgrade
```

The command will:

- fetch the configured upstream,
- create `backup/pre-patch-upgrade-<id>`,
- rebase local patch commits,
- keep upstream on conflicting files,
- save old patched file bytes to `~/.t3code/patch-upgrade-backups/<id>/`,
- write `manifest.json` when conflicts occur.

### 4. Resolve conflicts through the resolver skill

If the output says `upgraded_with_conflicts`, invoke
`skills/patch-resolve/SKILL.md`.

Do not paste old files over upstream. Re-apply intent using:

- current upstream file,
- backed-up patched file,
- matching `PATCH.md` entry,
- original patch commit diff if useful.

### 5. Verify

Run:

```sh
vp check
vp run typecheck
```

If native mobile code changed, also run:

```sh
vp run lint:mobile
```

### 6. Final report

Report:

- upstream branch and commits pulled,
- local patch commits replayed cleanly,
- conflicts and how each was handled,
- backup directory,
- rollback branch,
- verification results,
- any `PATCH.md` entries refreshed or retired.

## External-agent launch prompt

When T3 Code wants to start this from the UI, launch an external agent with a
prompt shaped like:

```text
Use the upgrade-t3code skill in this repo:
<absolute repo path>

Update this private T3 Code fork to the latest configured upstream. Run
`pnpm patch:upgrade`, use `skills/patch-resolve/SKILL.md` if conflicts are
reported, preserve PATCH.md intent, and run the required verification checks.
Report the rollback branch and backup directory.
```
