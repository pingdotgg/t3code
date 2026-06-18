---
name: patch-resolve
description: |
  Re-apply local T3 Code fork patches after `pnpm patch:upgrade` resolved
  conflicts by keeping upstream. Reads the backup manifest, asks for approval,
  then reconstructs each patch's intent from PATCH.md on top of the new code.
triggers:
  - "resolve patch upgrade conflicts"
  - "re-apply my t3code patches"
  - "reapply my t3code patches"
  - "patch upgrade had conflicts"
  - "restore my PATCH.md changes"
tools:
  - exec
  - read
mutating: true
---

# Patch Resolve - re-apply patches after an upstream-wins upgrade

`pnpm patch:upgrade` rebases local patch commits onto upstream. When a file
conflicts, upstream wins and the previous patched file is backed up. This skill
re-applies local intent afterward. It never runs unattended.

## Hard rules

1. Ask before changing anything. Show the conflicted files, patch commit
   subjects, and matching `PATCH.md` entries first.
2. Re-apply intent, not text. Use the backed-up file as evidence, not as a blob
   to paste over new upstream code.
3. Never guess. If the upstream code changed too much or `PATCH.md` is missing a
   clear entry, stop for that file and ask.
4. Verify before declaring done. At minimum run `vp check` and
   `vp run typecheck`; if native mobile code changed, also run
   `vp run lint:mobile`.

## Workflow

### 1. Locate the upgrade record

- Find the newest backup directory:
  `ls -t ~/.t3code/patch-upgrade-backups | head -1`
- Or use the `<id>` named by the user.
- Read `~/.t3code/patch-upgrade-backups/<id>/manifest.json`.

The manifest contains `repoRoot`, `backupRef`, `upstream`, and `conflicts[]`.
Each conflict includes `file`, `commit`, `subject`, and `backupPath`.

### 2. Ask for approval

Read `PATCH.md` at `repoRoot`. For each conflicted file, present:

- file path
- patch commit subject
- matching `PATCH.md` entry title
- backup path

Ask: "Re-apply these patches now?" Honor partial approval.

### 3. Re-apply one file at a time

For each approved file, gather:

- new upstream code: `<repoRoot>/<file>`
- old patched code: `backupPath`
- intent: matching `PATCH.md` entry
- optional context: `git -C <repoRoot> show <commit>`

Rewrite the new upstream file so the patch intent still holds. If upstream
already implemented the intent, skip the file and mark the `PATCH.md` entry
`Status: retired (upstreamed)`.

### 4. Verify

Run:

```sh
vp check
vp run typecheck
```

If native mobile code changed, also run:

```sh
vp run lint:mobile
```

If verification fails, revert the re-application for that file and report the
failure with the three reference points.

### 5. Commit and report

Commit one logical patch at a time:

```sh
git add <files>
git commit -m "patch: re-apply <subject> after upgrade <id>"
```

Refresh `PATCH.md` entries in a separate commit when needed.

Final report must include:

- files re-applied and how the new implementation differs from the old patch
- files skipped as upstreamed
- files blocked or ambiguous
- verification results
- rollback point and backup directory
