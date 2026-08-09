# Windows provider status probe timeouts

## Problem

On Windows, T3 Code provider health checks for **Codex**, **Cursor**, and **Grok** often reported:

- `Timed out while checking Codex app-server provider status.`
- `Cursor Agent CLI is installed but timed out while running \`agent about\`.`
- `Grok CLI is installed but ACP startup timed out after 15000ms.`

Claude and OpenCode continued to work because they do not rely on the same ACP/stdio cold-start path.

Root causes observed on Windows:

1. **Too-short timeouts** — e.g. Cursor `agent about` was capped at **8s** while cold starts commonly take **7–12s**.
2. **Invalid / unstable `process.cwd()`** for desktop probes when no project folder is open.
3. **Open stdin** on non-interactive probes — some CLIs wait for EOF and never exit until the probe times out.

## Changes

| Area                       | Change                                                        |
| -------------------------- | ------------------------------------------------------------- |
| `providerProbeTimeouts.ts` | Timeouts via `HostProcessPlatform`; accessible cwd resolution |
| `providerSnapshot.ts`      | Close stdin after spawn for CLI health probes                 |
| `CursorProvider.ts`        | Longer about/ACP timeouts; safe cwd; close stdin              |
| `GrokProvider.ts`          | Longer ACP/version timeouts; safe cwd                         |
| `CodexProvider.ts`         | Longer auth probe timeout; safe cwd                           |

### Timeouts (Windows / non-Windows)

| Probe                 | Windows | Other |
| --------------------- | ------- | ----- |
| Version (`--version`) | 15s     | 4s    |
| Codex app-server auth | 45s     | 15s   |
| Cursor `agent about`  | 45s     | 20s   |
| Cursor ACP discovery  | 45s     | 20s   |
| Grok ACP discovery    | 45s     | 20s   |

Env override for probe cwd (optional):

- `T3_PROVIDER_CWD`
- `T3CODE_PROVIDER_CWD`

## How to verify

From the repository root:

```bash
pnpm install
pnpm --filter t3 test -- src/provider/providerProbeTimeouts.test.ts
pnpm --filter t3 test -- src/provider/Layers/CursorProvider.test.ts
pnpm --filter t3 test -- src/provider/Layers/ProviderRegistry.test.ts
```

Then run the desktop app and open a real project folder before checking Providers.
