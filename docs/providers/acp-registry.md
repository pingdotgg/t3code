# ACP Registry

The ACP Registry is the catalog of coding agents that speak the
[Agent Client Protocol](https://agentclientprotocol.com). T3 Code bundles a
snapshot of the upstream registry (`cdn.agentclientprotocol.com/registry/v1/latest`)
so you can browse and install any conforming agent without leaving the app.

## What Ships In T3 Code

|                           |                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled entries           | 31 agents — everything in the upstream registry except the four overlapping with first-party drivers (`claude-acp`, `cursor`, `opencode`, `codex-acp`). |
| Distribution channels     | `binary` (downloaded, SHA256-verified, and extracted to a cache dir), `npx` (runs via `bunx`), `uvx` (runs via `uvx`).                                  |
| Where installs live       | macOS: `~/Library/Caches/t3code/<env>/acp-agents/<id>/<version>/`. Linux/Windows use the equivalent `ServerConfig.acpRegistryCacheDir`.                 |
| Where install state lives | `<ServerConfig.acpRegistryCacheDir>/installs.json` (migrated from `settings.json` on first read).                                                       |
| Icons                     | `apps/web/public/acp-icons/<id>.svg`, mirrored from `packages/contracts/src/registry/icons/`.                                                           |

## Browsing And Installing

Open **Settings → Providers** and use the **Add or install a provider** panel.
The legacy `/settings/acp-registry` route redirects to this panel. You'll see
one card per registry agent with:

- icon, display name, version
- the distribution channels available for your platform (e.g. `Binary · npx`)
- an **Install** or **Remove** button

The search box matches against id, name, and description.

Pressing **Install**:

1. Picks the first supported channel (binary if a target exists for your
   platform with a `sha256`, otherwise `npx`, then `uvx`).
2. For `binary`: downloads the archive (`.tar.gz`/`.tgz`/`.tar.bz2`/`.tbz2`/
   `.zip` or raw binary) to the cache dir, verifies the registry `sha256`,
   extracts it with `tar` or `Expand-Archive` on Windows, and `chmod +x`'s the
   declared `cmd`.
3. For `npx` / `uvx`: just records the choice — the spawn happens lazily.
4. Persists the result to `<acpRegistryCacheDir>/installs.json` so the install survives restarts.

Pressing **Remove** wipes the install state from the manifest and the agent's cache dir.

If an agent's binary target doesn't include your platform, is missing a
`sha256`, AND has no `npx`/`uvx` fallback, the card shows "Unsupported on this
platform" instead of an Install button.

## Authentication

ACP agents may declare authentication methods in their `initialize` response.
T3 Code detects these and surfaces them in two places:

1. **Settings → Providers**: When an agent requires authentication, the provider
   instance card shows an **Authentication** section with one button per
   advertised method (e.g. "Authenticate with OAuth"). Clicking a button
   triggers the agent's auth flow and marks the instance as authenticated.
2. **Chat**: If you try to use an unauthenticated agent, the status banner
   shows a friendly "This provider requires authentication" message with a link
   to Settings instead of a raw stack trace.

For agents that need API keys (Gemini, Mistral, Qwen, etc.), you can still set
variables in the per-instance **Environment variables** section after creating
the provider instance, the same way you would for any first-party provider.

## Refreshing The Bundle

The bundled snapshot is checked into source control for offline use. Refresh
it whenever you want to pick up new agents or version bumps:

```bash
bun run sync:acp-registry
```

This script:

1. Fetches the upstream `registry.json`.
2. Filters out the four overlapping ids (see above).
3. Sorts by id and writes `packages/contracts/src/registry/registry.json`.
4. Downloads every remaining `icon.svg` into both
   `packages/contracts/src/registry/icons/` and
   `apps/web/public/acp-icons/`.

Optional flags: `--registry-url <url>` (point at a fork), `--skip-icons`
(skip the download pass).

## Architecture Notes

- **Contracts**: `packages/contracts/src/acpRegistry.ts` defines the
  `AcpRegistryEntry` / install-state schemas. `packages/contracts/src/registry/index.ts`
  exports the bundled `ACP_REGISTRY` array, decoded once at load.
- **Server**: `apps/server/src/acpRegistry/`
  - `platform.ts` maps `os.platform()`/`os.arch()` to the registry's
    `darwin-aarch64` / `linux-x86_64` / etc. literal.
  - `installer.ts` is the framework-agnostic install/uninstall pipeline.
  - `installManifest.ts` persists install state to
    `<acpRegistryCacheDir>/installs.json` (atomic writes) with one-time
    migration from `ServerSettings.acpRegistryInstalls`.
  - `AcpRegistryService.ts` is the Effect service consumed by the WS RPC
    handlers (`acpRegistry.list` / `.install` / `.uninstall` /
    `.authenticate`).
- **Web**: `apps/web/src/components/settings/AddOrInstallProviderPanel.tsx`
  is the unified "Add or install a provider" panel rendered on
  `Settings → Providers`. The legacy `/settings/acp-registry` route
  (`apps/web/src/routes/settings.acp-registry.tsx`) redirects there.

## Capabilities

The adapter mirrors `CursorAdapter` / `OpenCodeAdapter` and supports:

- Full ACP session/turn/tool protocol.
- Authentication flows (OAuth, API keys, terminal prompts) discovered from
  the `initialize` handshake at install time.
- Model selection driven by the agent's `session/setup` config options.
- Auto-provisioned default provider instance per install so the agent shows
  up in the chat picker without the Add Provider Instance wizard.
- Cascade-delete: uninstalling removes auto-created provider instances.
- Active-session guard: uninstall is refused while a session is live.

Text generation (commit messages, PR descriptions, branch names, thread
titles) is intentionally **not** wired up for registry agents in v1 — those
flows stay on the first-party drivers.
