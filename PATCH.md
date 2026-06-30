# PATCH.md - Overwrite-prone local changes only

**Purpose.** This manifest tracks local changes to T3 Code-owned files that are
likely to collide with upstream when this repository is used as a private fork.
It is not for dependency patches under `patches/`, generated files, local
environment files, or one-off workspace notes.

No code snippets here. Record intent, scope, and enough reconstruction guidance
for a capable agent or developer to re-apply the change on top of newer upstream
code.

Last updated: 2026-06-18.

## How this file is used

`pnpm patch:upgrade` rebases the current branch onto its configured upstream.
Clean local patch commits replay automatically. When a local patch commit
conflicts, the command keeps the upstream version by default, saves the old
patched file under `~/.t3code/patch-upgrade-backups/<id>/`, and writes a
`manifest.json` with each conflict.

After that, use `skills/patch-resolve/SKILL.md` to re-apply the intended local
changes with explicit approval. The resolver should compare three reference
points: the new upstream file, the backed-up patched file, and the matching
entry in this manifest.

## Safe-change protocol

1. Commit each local patch as its own logical commit.
2. Add or refresh the matching entry in this file in the same logical unit.
3. Describe intent, not implementation text: what changed, why, and how to
   recreate it.
4. When upstream absorbs or obsoletes a patch, mark the entry `Status: retired`
   instead of deleting it.

Entries should use this format:

```md
## N. MODIFIED <area> - `path/to/file.ts`

**Change:** what behavior changed.
**Edit made:** concise implementation shape.
**Why:** why the patch exists.
**How to recreate:** how to rebuild it on top of new upstream code.
**Status:** optional status, for example `retired (upstreamed)`.
```

---

## Active Patches

Add local fork patches here as they are created.
