import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";

class PluginToolInvokeError extends Data.TaggedError("PluginToolInvokeError")<{
  readonly message: string;
}> {}

import {
  PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL,
  PLUGIN_TOOL_RESULT_MAX_UTF8_BYTES,
  PLUGIN_TOOL_TIMEOUT,
} from "../mcp/toolkits/plugins/pluginToolBounds.ts";
import { pluginToolFinalName } from "../mcp/toolkits/plugins/pluginToolNames.ts";
import {
  validatePluginToolDescriptors,
  validatePluginToolResult,
  type ValidatedPluginTool,
} from "../mcp/toolkits/plugins/pluginToolValidation.ts";
import { makePluginLogger } from "./PluginLogger.ts";
import { PluginRuntimeRegistry } from "./PluginRuntimeRegistry.ts";

export class PluginToolCatalogError extends Schema.TaggedErrorClass<PluginToolCatalogError>()(
  "PluginToolCatalogError",
  { pluginId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} tool catalog error: ${this.detail}`;
  }
}

export interface PermanentToolEntry {
  readonly pluginId: PluginId;
  readonly localName: string;
  readonly finalName: string;
  readonly description: string;
  readonly inputJsonSchema: unknown;
  readonly annotations: ValidatedPluginTool["annotations"];
  readonly fingerprint: string;
  /** True once McpServer.addTool has been called for this final name. */
  readonly addedToMcp: boolean;
}

interface CatalogState {
  readonly permanent: Map<string, PermanentToolEntry>;
  /** finalName set mirrored for synchronous EnabledWhen reads. */
  readonly active: Set<string>;
  readonly inFlight: Map<string, number>;
}

export class PluginToolCatalog extends Context.Service<
  PluginToolCatalog,
  {
    /**
     * Validate + reserve permanent ownership/fingerprints for a plugin's tools.
     * Safe to call before registry.put. Fails closed on collision or metadata drift.
     */
    readonly reserve: (
      pluginId: PluginId,
      tools: ReadonlyArray<PluginToolDescriptor> | undefined,
      options: { readonly hasToolsCapability: boolean },
    ) => Effect.Effect<ReadonlyArray<ValidatedPluginTool>, PluginToolCatalogError>;

    /** Mark reserved tools for pluginId as active (visible + callable). */
    readonly activate: (pluginId: PluginId) => Effect.Effect<void>;

    /** Clear active bindings for pluginId (visibility + call-time gate). */
    readonly deactivate: (pluginId: PluginId) => Effect.Effect<void>;

    /** Synchronous visibility predicate for McpSchema.EnabledWhen. */
    readonly isActive: (finalName: string) => boolean;

    /** Entries that still need McpServer.addTool (addedToMcp === false). */
    readonly pendingMcpRegistration: (
      pluginId: PluginId,
    ) => Effect.Effect<ReadonlyArray<PermanentToolEntry>>;

    readonly markAddedToMcp: (finalName: string) => Effect.Effect<void>;

    readonly getPermanent: (finalName: string) => Effect.Effect<Option.Option<PermanentToolEntry>>;

    readonly listActiveFinalNames: Effect.Effect<ReadonlyArray<string>>;

    /**
     * Trampoline handler factory: captures ONLY pluginId + localName.
     * Resolves current runtime + descriptor on every call.
     */
    readonly makeTrampolineHandle: (
      pluginId: PluginId,
      localName: string,
    ) => (payload: unknown) => Effect.Effect<McpSchema.CallToolResult, never>;
  }
>()("t3/plugins/PluginToolCatalog") {}

const errorResult = (text: string): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text }],
  });

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const serializedResultSize = (result: McpSchema.CallToolResult): number | null => {
  try {
    return utf8ByteLength(
      JSON.stringify({
        isError: result.isError,
        content: result.content,
        structuredContent: result.structuredContent,
      }),
    );
  } catch {
    return null;
  }
};

export const make = Effect.fn("PluginToolCatalog.make")(function* () {
  const registry = yield* PluginRuntimeRegistry;
  // Mutable Set shared with state.active for synchronous EnabledWhen predicates.
  const activeSync = new Set<string>();
  const stateRef = yield* Ref.make<CatalogState>({
    permanent: new Map(),
    active: activeSync,
    inFlight: new Map(),
  });

  const reserve: PluginToolCatalog["Service"]["reserve"] = (pluginId, tools, options) =>
    Effect.gen(function* () {
      const validated = yield* validatePluginToolDescriptors(pluginId, tools, options).pipe(
        Effect.mapError(
          (error) => new PluginToolCatalogError({ pluginId: error.pluginId, detail: error.detail }),
        ),
      );

      const state = yield* Ref.get(stateRef);
      const declaredFinalNames = new Set(validated.map((tool) => tool.finalName));

      // Reject descriptor-set removals: permanent MCP tools cannot be unregistered
      // (no removeTool), so a shrink would leave stale list entries that fail calls.
      for (const entry of state.permanent.values()) {
        if (entry.pluginId === pluginId && !declaredFinalNames.has(entry.finalName)) {
          return yield* new PluginToolCatalogError({
            pluginId,
            detail: `tool ${entry.localName} removed since last registration; restart required`,
          });
        }
      }

      for (const tool of validated) {
        const existing = state.permanent.get(tool.finalName);
        if (existing && existing.pluginId !== pluginId) {
          return yield* new PluginToolCatalogError({
            pluginId,
            detail: `tool final name ${tool.finalName} is already owned by plugin ${existing.pluginId}`,
          });
        }
        if (existing && existing.fingerprint !== tool.fingerprint) {
          return yield* new PluginToolCatalogError({
            pluginId,
            detail: `tool ${tool.localName} metadata changed since last registration; restart required`,
          });
        }
      }

      yield* Ref.update(stateRef, (current) => {
        const permanent = new Map(current.permanent);
        for (const tool of validated) {
          if (!permanent.has(tool.finalName)) {
            permanent.set(tool.finalName, {
              pluginId,
              localName: tool.localName,
              finalName: tool.finalName,
              description: tool.description,
              inputJsonSchema: tool.inputJsonSchema,
              annotations: tool.annotations,
              fingerprint: tool.fingerprint,
              addedToMcp: false,
            });
          }
        }
        return { ...current, permanent };
      });

      return validated;
    });

  const activate: PluginToolCatalog["Service"]["activate"] = (pluginId) =>
    Effect.gen(function* () {
      // Refuse to open call/visibility gates unless the runtime is published.
      // Closes the disable∩activation race: deactivate clears active, then a
      // late registry.put subscriber would re-activate while disable waits on
      // the activation lock — unless we require a live registry entry (which
      // post-put cancel removes under that lock).
      const runtime = yield* registry.get(pluginId);
      if (Option.isNone(runtime)) {
        return;
      }
      yield* Ref.update(stateRef, (state) => {
        for (const [finalName, entry] of state.permanent) {
          if (entry.pluginId === pluginId) {
            state.active.add(finalName);
          }
        }
        return state;
      });
      // Roll back if remove interleaved between the check and the add.
      const stillLive = yield* registry.get(pluginId);
      if (Option.isNone(stillLive)) {
        yield* Ref.update(stateRef, (state) => {
          for (const [finalName, entry] of state.permanent) {
            if (entry.pluginId === pluginId) {
              state.active.delete(finalName);
            }
          }
          return state;
        });
      }
    });

  const deactivate: PluginToolCatalog["Service"]["deactivate"] = (pluginId) =>
    Ref.update(stateRef, (state) => {
      for (const [finalName, entry] of state.permanent) {
        if (entry.pluginId === pluginId) {
          state.active.delete(finalName);
        }
      }
      return state;
    });

  const isActive: PluginToolCatalog["Service"]["isActive"] = (finalName) =>
    activeSync.has(finalName);

  const pendingMcpRegistration: PluginToolCatalog["Service"]["pendingMcpRegistration"] = (
    pluginId,
  ) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) =>
        Array.from(state.permanent.values()).filter(
          (entry) => entry.pluginId === pluginId && !entry.addedToMcp,
        ),
      ),
    );

  const markAddedToMcp: PluginToolCatalog["Service"]["markAddedToMcp"] = (finalName) =>
    Ref.update(stateRef, (state) => {
      const existing = state.permanent.get(finalName);
      if (!existing) return state;
      const permanent = new Map(state.permanent);
      permanent.set(finalName, { ...existing, addedToMcp: true });
      return { ...state, permanent };
    });

  const getPermanent: PluginToolCatalog["Service"]["getPermanent"] = (finalName) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => Option.fromUndefinedOr(state.permanent.get(finalName))),
    );

  const listActiveFinalNames: PluginToolCatalog["Service"]["listActiveFinalNames"] = Ref.get(
    stateRef,
  ).pipe(Effect.map((state) => Array.from(state.active)));

  const acquireInFlight = (finalName: string) =>
    Ref.modify(stateRef, (state) => {
      const current = state.inFlight.get(finalName) ?? 0;
      if (current >= PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL) {
        return [false as const, state];
      }
      const inFlight = new Map(state.inFlight);
      inFlight.set(finalName, current + 1);
      return [true as const, { ...state, inFlight }];
    });

  const releaseInFlight = (finalName: string) =>
    Ref.update(stateRef, (state) => {
      const current = state.inFlight.get(finalName) ?? 0;
      const inFlight = new Map(state.inFlight);
      if (current <= 1) {
        inFlight.delete(finalName);
      } else {
        inFlight.set(finalName, current - 1);
      }
      return { ...state, inFlight };
    });

  const mapHandlerCause = (
    pluginId: PluginId,
    localName: string,
    cause: Cause.Cause<Error>,
  ): Effect.Effect<McpSchema.CallToolResult, never> => {
    // Interrupt-first: external cancellation must propagate.
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.failCause(cause as Cause.Cause<never>);
    }
    if (Cause.hasDies(cause)) {
      return Effect.logError("Plugin tool handler defect", {
        pluginId,
        tool: localName,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(errorResult(`Plugin ${pluginId} tool ${localName} failed.`)));
    }
    const squashed = Cause.squash(cause);
    const message =
      typeof squashed === "object" &&
      squashed !== null &&
      "message" in squashed &&
      typeof (squashed as { message: unknown }).message === "string"
        ? (squashed as { message: string }).message
        : squashed instanceof Error
          ? squashed.message
          : String(squashed);
    return Effect.succeed(errorResult(message || `Plugin ${pluginId} tool ${localName} failed.`));
  };

  const makeTrampolineHandle: PluginToolCatalog["Service"]["makeTrampolineHandle"] = (
    pluginId,
    localName,
  ) => {
    // Capture ONLY ids — never schema, handler, or state.
    const finalName = pluginToolFinalName(pluginId, localName);

    return (payload: unknown) =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

          // Call-time gate (EnabledWhen is visibility only, never authorization).
          if (!activeSync.has(finalName)) {
            return errorResult(`Plugin ${pluginId} is not enabled.`);
          }

          const runtimeOption = yield* registry.get(pluginId);
          if (Option.isNone(runtimeOption)) {
            return errorResult(`Plugin ${pluginId} is not enabled.`);
          }
          const runtime = runtimeOption.value;
          const descriptor = (runtime.registration.tools ?? []).find(
            (tool) => tool.name === localName,
          );
          if (descriptor === undefined) {
            return errorResult(`Plugin ${pluginId} tool ${localName} is not available.`);
          }

          const acquired = yield* acquireInFlight(finalName);
          if (!acquired) {
            return errorResult(
              `Plugin ${pluginId} tool ${localName} is at concurrency limit (${PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL}).`,
            );
          }

          const logger = makePluginLogger(pluginId);

          // Decode + handle + result validation share one per-invocation timeout
          // (effectful decoders must not hold a concurrency slot forever).
          const invoke = Effect.gen(function* () {
            const decoded = yield* Schema.decodeUnknownEffect(descriptor.inputSchema)(payload).pipe(
              Effect.mapError(
                (error) =>
                  new PluginToolInvokeError({
                    message: `Invalid arguments for tool ${localName}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  }),
              ),
            );

            const rawResult = yield* Effect.suspend(() =>
              descriptor.handle(decoded, { pluginId, logger }),
            ).pipe(
              Effect.mapError(
                (error) =>
                  new PluginToolInvokeError({
                    message: error instanceof Error ? error.message : String(error),
                  }),
              ),
            );

            const validated = validatePluginToolResult(rawResult);
            if (!validated.ok) {
              return errorResult(validated.detail);
            }

            const callResult = new McpSchema.CallToolResult({
              isError: validated.value.isError ?? false,
              content: validated.value.content.map((item) => ({
                type: "text" as const,
                text: item.text,
              })),
              ...(validated.value.structuredContent === undefined
                ? {}
                : { structuredContent: validated.value.structuredContent }),
            });

            const size = serializedResultSize(callResult);
            if (size === null || size > PLUGIN_TOOL_RESULT_MAX_UTF8_BYTES) {
              return errorResult(
                `Plugin ${pluginId} tool ${localName} result exceeded ${PLUGIN_TOOL_RESULT_MAX_UTF8_BYTES} bytes.`,
              );
            }
            return callResult;
          }).pipe(
            Effect.timeoutOrElse({
              duration: PLUGIN_TOOL_TIMEOUT,
              orElse: () =>
                new PluginToolInvokeError({
                  message: `Plugin ${pluginId} tool ${localName} timed out after ${Duration.toMillis(PLUGIN_TOOL_TIMEOUT)}ms.`,
                }),
            }),
            Effect.catchCause((cause) =>
              mapHandlerCause(pluginId, localName, cause as Cause.Cause<Error>),
            ),
            Effect.ensuring(releaseInFlight(finalName)),
          );

          // Own the invocation fiber with the plugin runtime scope so disable /
          // Scope.close interrupts admitted handlers (they do not run on the
          // MCP request fiber alone).
          const fiber = yield* Effect.forkIn(invoke, runtime.scope);
          const result = yield* Fiber.join(fiber).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
          );

          const finishedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          yield* Effect.logInfo("plugin tool invocation", {
            pluginId,
            tool: localName,
            finalName,
            durationMs: finishedAt - startedAt,
            outcome: result.isError === true ? "error" : "ok",
          });

          return result;
        }),
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) {
            return Effect.failCause(cause as Cause.Cause<never>);
          }
          return Effect.succeed(
            errorResult(`Plugin ${pluginId} tool ${localName} failed unexpectedly.`),
          );
        }),
      );
  };

  return PluginToolCatalog.of({
    reserve,
    activate,
    deactivate,
    isActive,
    pendingMcpRegistration,
    markAddedToMcp,
    getPermanent,
    listActiveFinalNames,
    makeTrampolineHandle,
  });
});

/** Requires `PluginRuntimeRegistry` from the parent composition (do not double-build it). */
export const layer = Layer.effect(PluginToolCatalog, make());
