---
name: managed-t3code
description: |
  Use whenever editing T3 Code, especially a private fork. Keeps local
  overwrite-prone changes on patch branches, maintains PATCH.md, and routes
  update work through the upgrade-t3code skill.
triggers:
  - "edit t3code"
  - "work on t3code"
  - "change t3 code"
  - "modify t3 code"
  - "t3code patch"
  - "private t3code fork"
tools:
  - exec
  - read
  - write
mutating: true
---

# Managed T3 Code

Use this skill before making changes in this repository.

## First checks

1. Confirm the repo root with `git rev-parse --show-toplevel`.
2. Check the branch with `git branch --show-current`.
3. Check the working tree with `git status --short`.
4. Read `PATCH.md` before editing if the work may be a private fork patch.

## Branch rules

- Do not make private fork patches directly on `main`.
- If the user asks for local/private behavior and no patch branch exists, create
  a focused branch such as `patch/<short-name>` or ask before using an existing
  branch.
- Keep each local patch as a committed logical unit. The upgrade flow can only
  replay committed patches.

## PATCH.md rules

Update `PATCH.md` whenever a change:

- modifies T3 Code-owned files,
- is private/local rather than intended for immediate upstream contribution, and
- is likely to be overwritten or conflicted by upstream updates.

Do not add entries for:

- dependency patch files under `patches/`,
- generated files,
- local `.env` or machine config,
- vendored `.repos/` reference material unless explicitly patching that vendor
  copy as a tracked fork decision.

Each entry should describe intent, not code. Use:

```md
## N. MODIFIED <area> - `path/to/file.ts`

**Change:** what behavior changed.
**Edit made:** concise implementation shape.
**Why:** why the patch exists.
**How to recreate:** how to rebuild it on top of new upstream code.
**Status:** optional, for example `retired (upstreamed)`.
```

## During implementation

- Prefer existing T3 Code architecture and Effect patterns.
- Keep patch commits small enough that `pnpm patch:upgrade` can replay them
  independently.
- If a patch spans multiple areas, split it into separate commits and separate
  `PATCH.md` entries.
- When upstream already satisfies a patch intent, mark the entry
  `Status: retired (upstreamed)` instead of deleting it.

## Before finishing

1. Re-read the diff and decide whether `PATCH.md` needs an entry.
2. Run the repo-required checks:

```sh
vp check
vp run typecheck
```

3. If native mobile code changed, also run:

```sh
vp run lint:mobile
```

4. Report whether `PATCH.md` was updated or why it was not needed.
