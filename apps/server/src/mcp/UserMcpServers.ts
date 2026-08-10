/**
 * Live snapshot of enabled, user-configured MCP servers.
 *
 * Every provider adapter (Claude/Codex/Grok/Cursor/OpenCode) merges this
 * snapshot into its own MCP wiring at session start, alongside T3's
 * built-in "t3-code" server (see `McpProviderSession.ts`). Adapters read it
 * with a plain synchronous call — the same idiom
 * `McpProviderSession.readMcpProviderSession` uses — so none of the five
 * adapters need to depend on `ServerSettingsService` directly just to see
 * the current MCP server list. `layer` seeds the snapshot at boot and keeps
 * it current via `ServerSettingsService.streamChanges`, following the same
 * pattern as `ProviderInstanceRegistryHydration.ts`.
 *
 * @module UserMcpServers
 */
import type { McpServerConfig, ServerSettings } from "@t3tools/contracts";
import { McpServerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";

export interface EnabledMcpServer {
  readonly id: McpServerId;
  readonly config: McpServerConfig;
}

let snapshot: ReadonlyArray<EnabledMcpServer> = [];

function extractEnabled(settings: ServerSettings): ReadonlyArray<EnabledMcpServer> {
  return Object.entries(settings.mcpServers)
    .filter(([, config]) => config.enabled)
    .map(([id, config]) => ({ id: McpServerId.make(id), config }));
}

/** Plain synchronous read — call from adapter session-start code. */
export function readEnabledMcpServers(): ReadonlyArray<EnabledMcpServer> {
  return snapshot;
}

/** Exposed for tests. */
export const __testing = {
  setEnabledMcpServers(next: ReadonlyArray<EnabledMcpServer>): void {
    snapshot = next;
  },
};

/**
 * Seeds the snapshot from current settings and forks a daemon fiber (scoped
 * to this layer's lifetime) that keeps it current on every subsequent
 * settings change. Errors are logged and swallowed — a bad settings
 * emission should never take down MCP wiring for already-running sessions.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const initial = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    if (initial) snapshot = extractEnabled(initial);
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => {
          snapshot = extractEnabled(settings);
        }),
      ),
      Effect.catchCause((cause) => Effect.logError("UserMcpServers sync failed", cause)),
      Effect.forkScoped,
    );
  }),
);
