# Upstream Sync

This fork is desktop-first. Keep upstream syncs selective and do not blindly merge
large upstream branches into `main`.

## Pruned Surfaces

The following upstream surfaces are intentionally removed from this fork:

- `apps/mobile`
- `apps/marketing`
- mobile EAS workflow and mobile native static-check scripts

Do not restore these directories during upstream sync unless Bernardo explicitly
asks for them.

## Last Reviewed Upstream

- Last reviewed upstream commit: `5cda81562`
- Reviewed on: `2026-07-03`

Use this marker for selective syncs that manually port or skip upstream commits.
Those commits may continue to appear in `HEAD..upstream/main` because they were
not merged by ancestry.

Every sync, including scheduled task runs, must:

- read this marker before listing candidate upstream commits
- compare with `git log --oneline <last-reviewed-sha>..upstream/main`
- update this marker to the newest upstream commit that was reviewed, whether
  the change was merged, manually ported, or intentionally skipped
- mention the marker update in the PR body

## Recommended Flow

1. Fetch upstream.

   ```bash
   git fetch upstream
   ```

2. Inspect candidate commits.

   ```bash
   git log --oneline 5cda81562..upstream/main
   git diff --stat 5cda81562...upstream/main
   ```

   If the last reviewed upstream marker already matches `upstream/main`, stop:
   the fork is already reviewed against upstream.

3. Prefer cherry-picking or manually porting relevant changes in these areas:

   - `apps/server`
   - `apps/desktop`
   - `apps/web`
   - `packages/contracts`
   - `packages/shared`
   - `packages/client-runtime`
   - `packages/ssh`
   - `packages/tailscale`
   - `packages/effect-*`
   - desktop build/release scripts

4. If an upstream change touches a pruned surface plus shared code, port only the
   shared/server/desktop behavior needed by this fork.

5. Run the desktop-core quality path before finishing:

   ```bash
   pnpm run quality:core
   ```

6. For broad dependency or protocol updates, also run:

   ```bash
   pnpm run typecheck:full
   pnpm run test:full
   ```

## Conflict Policy

- Keep local branding and package/runtime names unless the sync explicitly needs
  otherwise.
- Keep `@t3tools/*` package names unless doing a deliberate package rename.
- Treat deleted mobile/marketing files as deleted when resolving conflicts.
- If upstream changes are mostly in pruned surfaces, skip them.
