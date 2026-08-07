# Fork rules (hafencity-dev/t3code)

This repo is a fork of `pingdotgg/t3code` (`upstream` remote). We regularly sync with upstream, so every fork-specific change must be written to keep merges cheap.

## Upstream-sync rule

- **Prefer additive code.** New features live in new files/modules/folders that upstream does not own. Plug into existing extension seams (provider registries, contract modules, panel/routing registries) instead of rewriting upstream code.
- **Minimize diffs to upstream-owned files.** When an upstream file must be touched, keep it to the smallest possible hook: one import, one registry entry, one render slot. Never reformat, reorder, or refactor upstream code in the same change.
- **Mark fork-only hooks.** Where a fork feature is wired into an upstream file, keep the edit on its own line(s) so a merge conflict resolves by re-adding that line.
- **Don't fork behavior silently.** If a fork feature needs upstream behavior changed (not just extended), isolate the change behind a fork-owned flag or wrapper so the upstream implementation stays intact underneath.
- **Syncing:** `git fetch upstream && git merge upstream/main`. After a sync, verify fork hooks (grep for `fork:` markers) survived the merge.

Fork-specific features so far: Codex/ChatGPT account support, system prompt injection, and the reworked git panel. Port planning docs live in `.plans/2code-port/` (gitignored).
