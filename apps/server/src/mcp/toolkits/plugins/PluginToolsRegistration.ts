import type { PluginId } from "@t3tools/contracts/plugin";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { PluginRuntimeRegistry } from "../../../plugins/PluginRuntimeRegistry.ts";
import { PluginToolCatalog } from "../../../plugins/PluginToolCatalog.ts";

class PluginToolRegistrationError extends Data.TaggedError("PluginToolRegistrationError")<{
  readonly pluginId: PluginId;
  readonly detail: string;
}> {}

/**
 * Core MCP tool names registered by the preview toolkit. Plugin final names are
 * also checked against the live `server.tools` list at addTool time.
 */
export const CORE_MCP_TOOL_NAMES = new Set([
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
]);

const registerPendingTools = Effect.fn("PluginToolsRegistration.registerPending")(function* (
  pluginId: PluginId,
) {
  const server = yield* McpServer.McpServer;
  const catalog = yield* PluginToolCatalog;

  const pending = yield* catalog.pendingMcpRegistration(pluginId);
  const existingNames = new Set(server.tools.map((entry) => entry.tool.name));

  // Preflight the COMPLETE pending set before the first irreversible addTool.
  // There is no removeTool — a partial add cannot be rolled back.
  const claimed = new Set(existingNames);
  for (const entry of pending) {
    if (CORE_MCP_TOOL_NAMES.has(entry.finalName) || claimed.has(entry.finalName)) {
      yield* Effect.logError("Plugin tool final-name collides with existing MCP tool", {
        pluginId,
        finalName: entry.finalName,
      });
      return yield* new PluginToolRegistrationError({
        pluginId,
        detail: `Plugin tool ${entry.finalName} collides with an existing MCP tool; registration aborted`,
      });
    }
    claimed.add(entry.finalName);
  }

  for (const entry of pending) {
    const annotations = Context.make(McpSchema.EnabledWhen, () =>
      catalog.isActive(entry.finalName),
    );

    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: entry.finalName,
        description: entry.description,
        inputSchema: entry.inputJsonSchema,
        annotations: {
          ...(entry.annotations.title === undefined ? {} : { title: entry.annotations.title }),
          readOnlyHint: entry.annotations.readOnlyHint,
          destructiveHint: entry.annotations.destructiveHint,
          idempotentHint: entry.annotations.idempotentHint,
          openWorldHint: entry.annotations.openWorldHint,
        },
      }),
      annotations,
      handle: catalog.makeTrampolineHandle(entry.pluginId, entry.localName),
    });

    yield* catalog.markAddedToMcp(entry.finalName);
  }

  // Only activate after a fully successful registration (or a no-op re-put).
  // Do not activate when collision preflight failed — rejection must propagate.
  yield* catalog.activate(pluginId);
});

const handleRuntimeChange = Effect.fn("PluginToolsRegistration.handleRuntimeChange")(function* (
  change:
    | { readonly _tag: "put"; readonly pluginId: PluginId }
    | {
        readonly _tag: "remove";
        readonly pluginId: PluginId;
      },
) {
  const catalog = yield* PluginToolCatalog;
  if (change._tag === "remove") {
    // Clear bindings BEFORE the plugin scope is fully torn down (host removes
    // from the runtime registry before Scope.close).
    yield* catalog.deactivate(change.pluginId);
    return;
  }
  yield* registerPendingTools(change.pluginId).pipe(
    Effect.catchTag("PluginToolRegistrationError", (error) =>
      Effect.logError("Failed to register plugin MCP tools", {
        pluginId: change.pluginId,
        error: error.detail,
      }),
    ),
  );
});

/**
 * Subscribes to PluginRuntimeRegistry and registers plugin tools once via
 * McpServer.addTool with EnabledWhen. Does not depend on PluginHost.
 *
 * Subscribe BEFORE snapshotting already-live plugins so a put/remove between
 * list and stream start is not lost. handleRuntimeChange is idempotent:
 * already-added tools are skipped (pending is empty), activate/deactivate are
 * set operations.
 */
export const registerPluginTools = Effect.fn("PluginToolsRegistration.register")(function* () {
  const registry = yield* PluginRuntimeRegistry;

  // Subscribe first (active before this effect continues). Forked Stream.fromPubSub
  // alone is not enough — the fiber may not have attached yet when list runs.
  const subscription = yield* registry.subscribeChanges;

  // Catch plugins that activated before this fiber subscribed.
  const alreadyLive = yield* registry.list;
  for (const runtime of alreadyLive) {
    yield* handleRuntimeChange({ _tag: "put", pluginId: runtime.manifest.id });
  }

  // Drain subsequent puts/removes for the process lifetime.
  yield* Effect.forever(
    PubSub.take(subscription).pipe(Effect.flatMap((change) => handleRuntimeChange(change))),
  ).pipe(Effect.forkScoped);
});

export const PluginToolsRegistrationLive = Layer.effectDiscard(registerPluginTools());
