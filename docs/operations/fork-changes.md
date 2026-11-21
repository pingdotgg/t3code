# Fork changes

`customized` is this fork's branch and upstream is `pingdotgg/t3code`. The difference
is not a patch file: an agent merges `upstream/main` and has to keep the intent below,
so this page is the inventory a merge resolves against. Keep it current when the fork
gains or drops a change — a merge that cannot find a change here treats it as upstream's
and can drop it.

## What the branch adds

- **The Sparrow provider** (`packages/provider-sparrow`), a full ACP provider with its
  driver, adapter, skills, status probe, settings and client entry. Upstream has no such
  provider, so every file under it is ours.
- **Fork releases** (`.github/workflows/fork-release.yml`), dispatch-only, tagging
  `v<manifest version>-fork.<n>` from the manifests plus this fork's tags. It never runs
  on push and never writes a version into a tracked file.
- **`t3 update` reads this fork's releases**: `packages/shared/src/cliRelease.ts` points
  `CLI_RELEASE_REPOSITORY` at `657kbps/t3code`, and `apps/server/src/cli/update.test.ts`
  asserts the same URL.

## Where it meets upstream

Registering a provider touches shared files, so a sync conflicts there. Each seam keeps
upstream's shape and the fork's behavior:

- **Contracts** — `packages/contracts/src/{providerPolicy,model,settings,server,managedPolicy,auth}.ts`
  carry the Sparrow provider id, its model options and its managed-policy plumbing.
- **Server provider plumbing** — `apps/server/src/provider/{builtInDrivers,providerStatusCache,settingsSecrets}.ts`,
  `model-manifest.json`, and the driver registration the provider needs. `agentContextBudget.json`
  is not hand-edited: `apps/server/src/provider/AgentContextBudget.test.ts` measures it,
  so a merge writes the values that test reports.
- **Policy and runtime modes** — `apps/server/src/policy/{managedProviders,managedSettings}.ts`
  and `apps/server/src/orchestration-v2/RuntimePolicy.ts` (with the Claude and Codex
  adapters beside it) map the fork's runtime modes onto the provider.
- **MCP surface** — `apps/server/src/mcp/{McpInvocationContext,delegatedTaskModes}.ts` and
  `mcp/toolkits/project/handlers.ts` expose it to delegated tasks.
- **ACP policy reuse** — `packages/provider-acp/src/server/clientPolicy.ts` exports and
  renames the policy helpers so Sparrow can reuse them instead of copying them.
- **Clients** — `packages/client-runtime/src/{contractLabels,providerClients}.ts`, the web
  composer and settings screens under `apps/web/src/components/{chat,settings,auth}`, and
  the mobile thread and settings screens with `apps/mobile/src/lib/modelOptions.ts`.
- **Translations** — `apps/{web,mobile}/src/i18n/translations/*.json`. Both sides' keys
  stay; where both changed one key, this fork's text wins.
- **Workspace wiring** — the `packages/provider-sparrow` entries in `package.json`,
  `apps/server/package.json`, `packages/client-runtime/package.json` and `pnpm-lock.yaml`.
  A lockfile conflict takes upstream's file, then `vp i` relinks the fork's package.
- **Workflows** — `customized` keeps upstream's `.github/workflows/*.yml` so a
  sync merges them instead of reporting a modify/delete conflict for each one.
  They are disabled through the GitHub API, not deleted; only
  `.github/workflows/fork-release.yml` stays enabled. A workflow upstream adds
  arrives active, so disable it after the sync.

## What is deleted on purpose

- `scripts/notify-discord-release.{ts,test.ts}`, which upstream keeps and this fork does
  not run.

## Mirroring `main`

`main` stays an exact mirror of `upstream/main` and never carries a commit of ours, so
pushing it is a fast-forward. GitHub runs a push's workflows from the pushed tree, so the
upstream workflows are switched off through the API before any push and any run that
started anyway is cancelled. They exist on both branches, so a sync only needs to disable
a workflow upstream newly adds. `gh` resolves this repository to its parent, so every
call passes `-R 657kbps/t3code`. `Fork release` is the one workflow that stays enabled;
check that it still is after the sweep, since a disabled one cannot be dispatched.

## Staying inside the checkout

Every step of a sync runs inside this checkout and needs no wider sandbox: the pnpm
store lives at `node_modules/.pnpm-store`, and `gh` and `git` only read `~/.config` and
`~/.ssh`, which the sandbox already allows. A step that would have to write outside the
checkout is one to leave for a human rather than a reason to widen the sandbox.
