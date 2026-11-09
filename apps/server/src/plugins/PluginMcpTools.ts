import { PluginId } from "@t3tools/contracts";
import type { PluginMcpTool, PluginRpcAccess } from "@t3tools/plugin-sdk/server";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { abortEffect, errorText } from "./api/facade.ts";

// MCP clients reject longer tool names.
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Every thread's agent reads every enabled plugin's tools.
const MAX_TOOLS_PER_PLUGIN = 32;
const MAX_DESCRIPTION_CHARS = 1000;
// Measured as the JSON clients receive.
const MAX_INPUT_SCHEMA_CHARS = 4000;
// Names, descriptions and input schemas together. Per plugin, so whether one plugin's tools fit
// never depends on which other plugins started first.
const MAX_DEFINITION_CHARS_PER_PLUGIN = 24_000;
// Longer than a client's call, because a tool may do real work, but a hung one frees the turn.
const TOOL_CALL_DEADLINE = Duration.minutes(5);

const isJson = Schema.is(Schema.Json);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));

export class PluginMcpToolNameError extends Schema.TaggedError<PluginMcpToolNameError>()(
  "PluginMcpToolNameError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Tool names use letters, digits, "_" and "-", and plg_${this.pluginId}_<name> must fit in ${MAX_TOOL_NAME_CHARS} characters.`;
  }
}
export const isPluginMcpToolNameError = Schema.is(PluginMcpToolNameError);

export class PluginMcpToolLimitError extends Schema.TaggedError<PluginMcpToolLimitError>()(
  "PluginMcpToolLimitError",
  {
    tool: Schema.String,
    limit: Schema.Literals(["tools", "definitions", "description", "inputSchema"]),
  },
) {
  override get message(): string {
    switch (this.limit) {
      case "tools":
        return `A plugin registers at most ${MAX_TOOLS_PER_PLUGIN} tools, so "${this.tool}" was not added.`;
      case "definitions":
        return `A plugin's tools take at most ${MAX_DEFINITION_CHARS_PER_PLUGIN.toLocaleString("en-US")} characters of names, descriptions and input schemas together, so "${this.tool}" was not added.`;
      case "description":
        return `Tool "${this.tool}" needs a description of at most ${MAX_DESCRIPTION_CHARS} characters.`;
      case "inputSchema":
        return `Tool "${this.tool}" needs an input schema of at most ${MAX_INPUT_SCHEMA_CHARS} characters as JSON.`;
    }
  }
}

// `reason` is the plugin's own error text, bounded, so the agent can see why the tool failed.
export class PluginMcpToolError extends Schema.TaggedError<PluginMcpToolError>()(
  "PluginMcpToolError",
  { pluginId: PluginId, tool: Schema.String, reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed in ${this.tool}: ${this.reason}`;
  }
}

export class PluginMcpToolTimeoutError extends Schema.TaggedError<PluginMcpToolTimeoutError>()(
  "PluginMcpToolTimeoutError",
  { pluginId: PluginId, tool: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} did not answer ${this.tool} within ${Duration.toMinutes(TOOL_CALL_DEADLINE)} minutes.`;
  }
}

export class PluginMcpToolDisabledError extends Schema.TaggedError<PluginMcpToolDisabledError>()(
  "PluginMcpToolDisabledError",
  { pluginId: PluginId },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is disabled.`;
  }
}

/** `/mcp` checks `access` before it runs `call`. */
export interface PluginMcpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  readonly access: PluginRpcAccess;
  readonly call: (
    input: Schema.JsonObject,
    caller: { readonly threadId: string | null },
  ) => Effect.Effect<
    Schema.Json,
    PluginMcpToolError | PluginMcpToolTimeoutError | PluginMcpToolDisabledError
  >;
}

export class PluginMcpTools extends Context.Service<
  PluginMcpTools,
  {
    /** Offers `tool` to agents as `plg_<pluginId>_<name>`, replacing a tool of that name. */
    readonly register: (input: {
      readonly pluginId: PluginId;
      readonly tool: PluginMcpTool;
      /** `signal` aborts when the agent cancels the call or the deadline passes. */
      readonly handler: (
        input: Schema.JsonObject,
        context: { readonly signal: AbortSignal; readonly threadId: string | null },
      ) => Promise<Schema.Json>;
      /** Aborts when the plugin turns off; a call still running then answers that it is disabled. */
      readonly deactivated: AbortSignal;
    }) => Effect.Effect<void, PluginMcpToolNameError | PluginMcpToolLimitError>;
    readonly unregisterPlugin: (pluginId: PluginId) => Effect.Effect<void>;
    /**
     * Whether `/mcp` lists and runs the tool, read on every list and call. Withdrawn tools stay
     * registered, because MCP servers can't remove one, so this hides them.
     */
    readonly isOffered: (name: string) => boolean;
    /**
     * Hands `publish` every tool now and each change until the scope closes. A withdrawn tool is
     * published again, so clients hear the list changed.
     */
    readonly attach: (
      publish: (tool: PluginMcpToolEntry) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/plugins/PluginMcpTools") {}

const make = () => {
  // Every change runs synchronously, so plugin activation can register a tool and return.
  const tools = new Map<string, PluginMcpToolEntry>();
  // Each plugin's tools by name, with the characters each one's definition takes.
  const toolsByPlugin = new Map<PluginId, Map<string, number>>();
  const publishers = new Set<(tool: PluginMcpToolEntry) => Effect.Effect<void>>();
  // Inside `register` or `unregisterPlugin`, which have their spans.
  const publish = Effect.fnUntraced(function* (entry: PluginMcpToolEntry) {
    tools.set(entry.name, entry);
    for (const publisher of publishers) yield* publisher(entry);
  });
  const withdraw = Effect.fnUntraced(function* (name: string) {
    const entry = tools.get(name);
    if (entry === undefined) return;
    tools.delete(name);
    for (const publisher of publishers) yield* publisher(entry);
  });

  return PluginMcpTools.of({
    register: Effect.fn("PluginMcpTools.register")(function* ({
      pluginId,
      tool,
      handler,
      deactivated,
    }) {
      const name = `plg_${pluginId}_${tool.name}`;
      if (!TOOL_NAME_PATTERN.test(tool.name) || name.length > MAX_TOOL_NAME_CHARS) {
        return yield* new PluginMcpToolNameError({ pluginId });
      }
      if (tool.description.length > MAX_DESCRIPTION_CHARS) {
        return yield* new PluginMcpToolLimitError({ tool: tool.name, limit: "description" });
      }
      const schemaChars = encodeJson(tool.inputSchema).length;
      if (schemaChars > MAX_INPUT_SCHEMA_CHARS) {
        return yield* new PluginMcpToolLimitError({ tool: tool.name, limit: "inputSchema" });
      }
      const sizes = toolsByPlugin.get(pluginId) ?? new Map<string, number>();
      if (!sizes.has(name) && sizes.size >= MAX_TOOLS_PER_PLUGIN) {
        return yield* new PluginMcpToolLimitError({ tool: tool.name, limit: "tools" });
      }
      const size = name.length + tool.description.length + schemaChars;
      let others = 0;
      for (const [other, otherSize] of sizes) if (other !== name) others += otherSize;
      if (others + size > MAX_DEFINITION_CHARS_PER_PLUGIN) {
        return yield* new PluginMcpToolLimitError({ tool: tool.name, limit: "definitions" });
      }
      const failed = (cause: unknown) =>
        new PluginMcpToolError({ pluginId, tool: tool.name, reason: errorText(cause), cause });
      toolsByPlugin.set(pluginId, sizes.set(name, size));
      yield* publish({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        access: tool.access,
        call: (input, caller) =>
          Effect.raceFirst(
            Effect.tryPromise({
              try: (signal) => handler(input, { signal, threadId: caller.threadId }),
              catch: failed,
            }).pipe(
              // The deadline interrupts the call, which aborts the handler's signal.
              Effect.timeoutOrElse({
                duration: TOOL_CALL_DEADLINE,
                orElse: () =>
                  Effect.fail(new PluginMcpToolTimeoutError({ pluginId, tool: tool.name })),
              }),
              Effect.flatMap((output: unknown) =>
                output === undefined
                  ? Effect.succeed(null)
                  : isJson(output)
                    ? Effect.succeed(output)
                    : Effect.fail(
                        failed(new TypeError("The tool returned a value that is not JSON.")),
                      ),
              ),
            ),
            // A handler that ignores its abort signal must not hold the agent's call open.
            abortEffect(deactivated).pipe(
              Effect.andThen(Effect.fail(new PluginMcpToolDisabledError({ pluginId }))),
            ),
          ),
      });
    }),
    unregisterPlugin: Effect.fn("PluginMcpTools.unregisterPlugin")(function* (pluginId) {
      const sizes = toolsByPlugin.get(pluginId);
      toolsByPlugin.delete(pluginId);
      for (const name of sizes?.keys() ?? []) yield* withdraw(name);
    }),
    isOffered: (name) => tools.has(name),
    attach: Effect.fn("PluginMcpTools.attach")((publisher) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          publishers.add(publisher);
          for (const entry of tools.values()) yield* publisher(entry);
        }),
        () => Effect.sync(() => publishers.delete(publisher)),
      ),
    ),
  });
};

export const layer = Layer.sync(PluginMcpTools, make);
