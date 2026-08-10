# Maintaining the Auldric T3 baseline

> For Auldric maintainers. This runbook governs intake from T3; it does not change T3's release
> process.

Auldrics treats [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) as authoritative for Dev,
provider sessions, runtime transport, the client shell, prompts, agents, tools, and coding UX. The
legacy Auldric runtime commit `cf6400e77dfaf9569f1ce6eaca4421deb0b2bf23` is donor material only.
Never merge that history or resolve an intake conflict by retaining its platform behavior.

## Canonical refs and current pin

The two canonical remotes are:

```text
origin    https://github.com/AuldricAI/auldrics.git
upstream  https://github.com/pingdotgg/t3code.git
```

The machine-readable pin and update proof live in [`.auldric/t3-baseline.json`](../../.auldric/t3-baseline.json).
The selected T3 baseline is `9a1472d9558ec74b5ed419bd7b87b2aa0e6be1e6`.

This intake fast-forwarded Auldrics from
`1a003e383ac6b10258b8100c2617d938c4f06c69` to the selected baseline. Before intake the fork was
0 commits ahead and 12 behind T3; immediately after the fast-forward it was 0 ahead and 0 behind.
The 20 changed paths are recorded in the baseline file. There were no conflicts and no legacy
Auldric commits were introduced.

Configure and verify the remotes without rewriting an existing remote:

```bash
git remote get-url origin
git remote get-url upstream || git remote add upstream https://github.com/pingdotgg/t3code.git
test "$(git remote get-url upstream)" = "https://github.com/pingdotgg/t3code.git"
git fetch --prune upstream main
```

## Required check

Run the human-readable guard from a clean checkout:

```bash
node scripts/auldric/check-t3-baseline.ts --fetch
```

For automation or release evidence, request JSON:

```bash
node scripts/auldric/check-t3-baseline.ts --fetch --json
```

The command verifies that the pin is in current `upstream/main`, that it is an ancestor of the
release commit, and that the checkout is clean. It reports release/upstream commit drift and every
path changed after the pin. It fails changes outside these categories:

- new files below a machine-declared Auldric Marketing root;
- the exact distribution and governance files declared in the baseline file;
- an existing T3-owned path with a valid temporary entry in the shared-core allowlist.

The focused GitHub workflow [`.github/workflows/auldric-t3-baseline.yml`](../../.github/workflows/auldric-t3-baseline.yml)
runs the guard tests and the fetched ancestry/drift check on every pull request and every push to
`main`.

## Accepting a later T3 baseline

Do not merge T3 into a long-lived downstream platform branch. Build the candidate from the selected
T3 commit and replay only reviewed, isolated Auldric commits:

1. Fetch and record the starting relationship.

   ```bash
   git fetch --prune upstream main
   git rev-list --left-right --count HEAD...upstream/main
   git diff --name-status HEAD..upstream/main
   ```

2. Create an intake branch directly from the exact reviewed T3 commit.

   ```bash
   git switch --create intake/t3-YYYY-MM-DD <reviewed-t3-sha>
   git merge-base --is-ancestor <reviewed-t3-sha> upstream/main
   ```

3. Cherry-pick only additive Marketing, distribution, and approved temporary-seam commits. If a
   replay touches a T3-owned path unexpectedly, abort it. Do not choose the legacy/downstream side
   of the conflict.

   ```bash
   git cherry-pick <reviewed-auldric-commit>...
   # On an unexpected shared-core conflict:
   git cherry-pick --abort
   ```

4. Update the pin and its before/after proof in `.auldric/t3-baseline.json`, then run the focused
   test and guard.

   ```bash
   pnpm --dir scripts run test -- auldric/check-t3-baseline.test.ts
   node scripts/auldric/check-t3-baseline.ts --fetch
   ```

5. Verify the candidate ref, changed paths, and exact ancestry before release.

   ```bash
   git rev-parse HEAD
   git merge-base --is-ancestor <recorded-t3-sha> HEAD
   git diff --name-status <recorded-t3-sha>..HEAD
   ```

The automated update simulation exercises this same model: it starts a release at a later T3
commit, replays isolated Marketing files, and proves the resulting release keeps the later T3 core
contents unchanged.

## Temporary shared-core seams

The allowlist is [`.auldric/shared-core-allowlist.json`](../../.auldric/shared-core-allowlist.json)
and is empty by default. Each entry is exact-path only and must include:

```json
{
  "path": "apps/web/example.ts",
  "owner": "@maintainer",
  "reason": "Why the smallest shared seam is temporarily required",
  "expiresOn": "2026-09-01",
  "upstream": {
    "status": "proposed",
    "url": "https://github.com/pingdotgg/t3code/issues/123"
  },
  "test": "pnpm --dir apps/web run test -- src/example.test.ts"
}
```

Expired entries, duplicate paths, missing metadata, non-T3 paths, and non-T3 upstream links fail the
guard. The owner must remove the seam or refresh it through review before its expiry. A generic
missing capability remains an upstream dependency; the allowlist is not permission to fork Dev.

## Rollback and recovery

- If a baseline candidate is bad before merge, abandon that candidate branch and continue from the
  last accepted release. Do not move a shared branch with a hard reset.
- If a pin or intake commit was merged incorrectly, use `git revert <intake-commit>` so the recovery
  remains reviewable, then redeploy the last known-good release.
- If upstream history no longer contains the recorded pin, stop intake and investigate the upstream
  rewrite. Select a replacement only after comparing its complete tree with the last accepted pin.
- If replay conflicts in T3-owned code, abort the replay and restart from upstream. Re-express only
  the minimal Marketing extension at an approved boundary, or open an upstream dependency.
- If `origin/main` is damaged, create a recovery branch from the last verified release ref, run the
  JSON guard, and repair through a reviewed commit. Never recover by merging the legacy runtime.
