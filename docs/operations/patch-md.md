# PATCH.md fork maintenance

T3 Code supports an agent-readable `PATCH.md` workflow for private forks. The
goal is to make local changes durable across upstream updates without storing
fragile code hunks as the source of truth.

## Files

- `PATCH.md` records overwrite-prone local patch intent.
- `scripts/patch-upgrade.ts` rebases local patch commits onto upstream safely.
- `skills/managed-t3code/SKILL.md` keeps future T3 Code edits patch-aware.
- `skills/upgrade-t3code/SKILL.md` runs the update workflow.
- `skills/patch-resolve/SKILL.md` re-applies conflicting patch intent after an
  upstream-wins upgrade.

## Normal patch workflow

1. Work on a patch branch, not directly on `main`.
2. Keep local fork changes in committed logical patches.
3. Add or refresh the matching `PATCH.md` entry in the same logical unit.
4. Run the normal verification checks before handing off:

```sh
vp check
vp run typecheck
```

If native mobile code changed, also run:

```sh
vp run lint:mobile
```

## Upgrade workflow

Run the upgrade through the skill:

```text
Use skills/upgrade-t3code/SKILL.md
```

The skill runs:

```sh
pnpm patch:upgrade
```

The script requires a clean working tree, fetches the configured upstream,
creates a rollback branch, and rebases local patch commits. If a local patch
conflicts with upstream, upstream wins by default and the previous patched file
is backed up under:

```text
~/.t3code/patch-upgrade-backups/<id>/
```

The backup directory includes `manifest.json`, which points the resolver skill
at the conflicted files and original patch commits.

## Resolving conflicts

Use:

```text
Use skills/patch-resolve/SKILL.md
```

The resolver compares:

- the new upstream file,
- the backed-up patched file,
- the matching `PATCH.md` entry,
- the original patch commit diff when useful.

It should re-apply intent, not paste old code over upstream. If upstream already
implemented the intent, mark the `PATCH.md` entry retired instead of deleting it.

## Launching from the app

The safest product path is to launch an external agent session instead of making
T3 Code update itself while hosting the agent. A future UI button can open a
Codex or Claude Code deep link with a prompt that tells the external agent to
use `skills/upgrade-t3code/SKILL.md` in the target repo path.
