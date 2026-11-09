import type { JsonObject, JsonValue, PluginRpcMap } from "./shared.ts";

/** `read` methods need the caller's `orchestration:read` scope, `write` methods `orchestration:operate`. */
export type PluginRpcAccess = "read" | "write";

export interface PluginRpcContext {
  /**
   * Aborts when the caller goes away, the plugin deactivates, or the handler has not answered
   * within 30 seconds, when the call fails.
   */
  readonly signal: AbortSignal;
  /**
   * What the caller's session may call: `write` if it may call `write` methods, else `read`. A
   * `read` method can use it to tell a read-only session, such as a guest's, from the owner's.
   */
  readonly access: PluginRpcAccess;
}

export type PluginRpcHandler<
  Method extends PluginRpcMap["methods"][string] = PluginRpcMap["methods"][string],
> = (
  input: Method["input"],
  context: PluginRpcContext,
) => Method["output"] | Promise<Method["output"]>;

/** How every rejected API call fails. `code` names the server's error; treat it as opaque. */
export interface PluginApiError extends Error {
  readonly code: string;
}

/**
 * A plugin registers at most 32 tools, whose names, descriptions and schemas take at most 24,000
 * characters together, because agents in every thread see them all. A call that hasn't answered
 * within 5 minutes fails with an error the agent reads, and its `signal` aborts.
 */
export interface PluginMcpTool {
  /** Agents see the tool as `plg_<pluginId>_<name>`. Letters, digits, `_` and `-`. */
  readonly name: string;
  /** At most 1000 characters. */
  readonly description: string;
  /** JSON Schema for the tool's arguments, at most 4000 characters as JSON. */
  readonly inputSchema: JsonObject;
  /**
   * Every agent sees the tool. A `write` tool runs only for an agent in a thread set to Full
   * access and not in Plan mode, or an outside agent approved with Full access; others get a
   * refusal that says so. Agents from linked environments can't call it.
   */
  readonly access: PluginRpcAccess;
}

export type PluginMcpToolHandler = (
  input: JsonObject,
  context: {
    /** Aborts when the agent cancels the call, the plugin deactivates, or 5 minutes pass. */
    readonly signal: AbortSignal;
    /** The thread whose agent called the tool, or null for an MCP client outside a thread. */
    readonly threadId: string | null;
  },
) => JsonValue | Promise<JsonValue>;

export interface PluginLogger {
  readonly debug: (message: string, fields?: JsonObject) => void;
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/**
 * What `activate` receives. Everything is scoped to one activation and released on deactivate.
 * `Rpc` types the methods and channels the web half calls.
 */
export interface PluginApi<Rpc extends PluginRpcMap = PluginRpcMap> {
  /**
   * The server API's version, a separate number from the web half's `api.version`. T3 raises it
   * when `PluginApi` gains a member, whose doc then names the version that added it, so a plugin
   * can check it before using a member an older T3 lacks. To refuse older T3 releases outright, set
   * `engines.t3` in the manifest.
   */
  readonly version: number;
  readonly id: string;
  readonly rootDir: string;
  readonly log: PluginLogger;
  readonly settings: {
    /**
     * The saved settings, secret values included. Fields nobody saved read as the `default` in
     * the manifest's `settingsSchema`, at the top level and for fields that are not secrets.
     */
    readonly get: () => Promise<JsonObject>;
    /** Yields the settings as `get` reads them after each change, until deactivation. */
    readonly changes: () => AsyncIterable<JsonObject>;
  };
  readonly storage: {
    readonly get: (key: string) => Promise<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
    readonly list: (prefix?: string) => Promise<ReadonlyArray<string>>;
  };
  readonly rpc: {
    /**
     * Answers `plugins.invoke` calls for `method` from clients. `input` has the type `Rpc` gives
     * it, but a client can send any JSON, so check input before acting on it.
     */
    readonly register: <Method extends Extract<keyof Rpc["methods"], string>>(
      method: Method,
      handler: PluginRpcHandler<Rpc["methods"][Method]>,
      options: { readonly access: PluginRpcAccess },
    ) => void;
    /**
     * Sends `value` to every `plugins.subscribe` caller on `channel`. Any session that can read
     * this environment may subscribe, so never publish secrets. Throws when `value` is over 256 KB
     * as JSON, the limit a method's result has too.
     */
    readonly publish: <Channel extends Extract<keyof Rpc["channels"], string>>(
      channel: Channel,
      value: Rpc["channels"][Channel],
    ) => void;
  };
  /** Runs when the plugin is disabled or reloaded, or the server stops; at once if that already happened. */
  readonly onDeactivate: (cleanup: () => void | Promise<void>) => void;
  readonly mcp: {
    /**
     * Offers a tool to agents in every thread until the plugin deactivates. Then it leaves new tool
     * lists, and a call to it fails as an unknown tool.
     */
    readonly registerTool: (tool: PluginMcpTool, handler: PluginMcpToolHandler) => void;
  };
}

export interface PluginDefinition<Rpc extends PluginRpcMap = PluginRpcMap> {
  readonly activate: (api: PluginApi<Rpc>) => void | Promise<void>;
}

/**
 * Types a server plugin. The CommonJS entry sets `module.exports` to the result. Pass the plugin's
 * `PluginRpcMap`, as in `definePlugin<NotesRpc>({ ... })`, to type `api.rpc`.
 */
export const definePlugin = <Rpc extends PluginRpcMap = PluginRpcMap>(
  definition: PluginDefinition<Rpc>,
): PluginDefinition<Rpc> => definition;
