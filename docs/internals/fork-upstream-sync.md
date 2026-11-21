# Fork upstream sync

Lathe renames upstream's names (T3 Code, the `@t3tools` scope, the `t3-code` MCP server, `T3CODE_*`
variables, the `t3-citation://` link schemes) to Lathe values in the source. Done by hand, every
upstream line that names one of them would conflict on every sync. Instead the rename is a
deterministic codemod, and the fork merges upstream through a mirror branch that already holds
upstream renamed. Both sides of a merge then agree on every renamed line, and only real changes
conflict.

## The rename

[`scripts/lib/forkRenameRules.ts`](../../scripts/lib/forkRenameRules.ts) classifies every `t3`
(any case) in the tracked files. The first matching rule wins. Renamed classes (identifier,
display, agent-facing, persisted) are rewritten; the others (kept, wire-peer, upstream-reference,
false-positive) stay byte-identical. An occurrence no rule covers stops the codemod, so a new
upstream name is decided by a person once, instead of guessed.

- `node scripts/fork-rename-codemod.ts` is a dry run; `--write` applies it.
- `node scripts/fork-rename-report.ts --output <file>` lists every class and rule with examples.
- On `main` the dry run reports zero renames. Never edit renamed output by hand. Change a rule,
  with a test in `forkRenameRules.test.ts`, and regenerate.

## Compatibility with old names

Users and stored data still hold the old names: environment variables in service units and
profiles, `t3-*` links in stored messages, `t3_*` tool names in transcripts. Code that reads an old
name lives only in files named `forkLegacy*`, which the rules keep whole, along with its tests.
A literal old name anywhere else would be renamed by the next codemod run and silently stop
working.

## The mirror branch

`upstream-lathe` holds one commit per sync: upstream at one commit, run through the codemod and
`vp fmt`, with a regenerated lockfile and an `Upstream: <sha>` trailer. Each commit's parent is
the previous mirror commit. `main` merges it like any branch. The first commit was merged into
`main` with `-s ours`, because `main` already held the same rename.

To sync, from a worktree of `main`:

1. `git fetch upstream` and choose the upstream commit, usually `upstream/main`.
2. Add a detached worktree at that commit and copy `scripts/lib/forkRename*.ts`,
   `scripts/lib/forkI18n*.ts`, `scripts/fork-rename-codemod.ts` and
   `scripts/fork-i18n-catalogs.ts` from `main` into it.
3. Run `node scripts/fork-rename-codemod.ts`. If it reports unclassified occurrences, add rules on
   `main` first, then copy them again.
4. Run it with `--write`, then `node scripts/fork-i18n-catalogs.ts rekey`. GT catalogs key each message by
   a hash of its English text, so every renamed message gets a new key; the script regenerates each
   app's `en.json` and moves locale entries to the new keys, and refuses when a rule renamed the
   source and its catalog text differently. Delete the copied fork scripts, then run `vp fmt` on the
   changed files and `vp i --lockfile-only`.
5. Commit the whole tree on top of `upstream-lathe` with the `Upstream: <sha>` trailer, using
   `git commit-tree` so the parent is the previous mirror commit.
6. Merge `upstream-lathe` into a sync branch of `main`, resolve conflicts, and confirm the codemod
   dry run still reports zero. Lathe's own copy is English only: take `upstream-lathe`'s side of a
   catalog conflict, then run `node scripts/fork-i18n-catalogs.ts fill`, which drops stale messages
   and adds the fork's in English. Fork-only client files are exempt from `no-untranslated-copy`
   through `scripts/lib/forkEnglishOnlyFiles.ts`; fork strings in upstream files are wrapped.

Never merge `upstream/main` into `main` directly. Its unrenamed lines conflict with every renamed
line in the fork.

## Deliberate exceptions

- The mobile app keeps upstream's identity, native module names and fonts until its own rename.
  Its source follows shared code where shared code renamed a value it consumes.
- T3 Connect stays upstream's service, so its hosts and protocol names are wire-peer
  ([#71](https://github.com/jamesainslie/t3code/issues/71) tracks running Lathe's own).
- Names compiled into vendored binaries, the macOS keychain item, and repository names that a
  hosting provider owns are kept.
