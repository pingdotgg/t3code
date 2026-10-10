/**
 * Tools that enabled plugins offer to agents, behind the two fixed MCP tools
 * `plugin_tools_list` and `plugin_tool_call`.
 *
 * Tools are declared in the consented manifest, so listing them reads the
 * catalogue and never starts a plugin; only a call does. A provider session
 * holds a snapshot of grants, taken when its MCP credential was prepared: the
 * tool plugins enabled at that moment, each with its registration generation.
 * Every list and call intersects that snapshot with the catalogue as it is
 * now, so a plugin disabled, removed, or re-registered since then is refused
 * at once, and a plugin enabled later waits for a new session. Calls are
 * pinned to the granted generation all the way into the supervisor, and
 * disabling a plugin fails its calls in flight.
 */
import {
  PLUGIN_TOOL_LIMITS,
  PLUGIN_TOOLS_CAPABILITY,
  type PluginInstallation,
  type PluginInstallationId,
  PluginToolError,
  type PluginToolListing,
  type PluginToolsListResult,
  parseQualifiedPluginToolName,
  pluginInstallationStatus,
  pluginToolHandlerName,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PluginCatalog } from "./PluginCatalog.ts";
import {
  jsonBytes,
  preparePluginTools,
  type PreparedPluginTools,
} from "./pluginToolDeclarations.ts";

/** One tool plugin a session may use: the registration that was enabled when it was prepared. */
export interface PluginToolGrant {
  readonly installationId: PluginInstallationId;
  readonly generation: number;
}

type Plugin = PluginToolListing["plugin"];

/** A live tool plugin, as the sorted index holds it. */
interface Indexed {
  readonly plugin: Plugin;
  readonly installation: PluginInstallation;
  /** Its size under notInThisSession, separator included. */
  readonly nameBytes: number;
}

/** The live tool plugins by id, rebuilt only when the catalogue's records change. */
interface Index {
  readonly revision: number;
  readonly ids: ReadonlyArray<string>;
  readonly byId: ReadonlyMap<string, Indexed>;
}

const MAX_REASON_LENGTH = 500;
/** The page envelope with the longest cursor a plugin id allows. */
const LIST_ENVELOPE_BYTES = jsonBytes({
  tools: [],
  notInThisSession: [],
  nextCursor: "x".repeat(128),
});

const decodeJsonObject = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Json));
const cut = (text: string) =>
  text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;

const toolError = (reason: string, message: string) =>
  new PluginToolError({ reason, message: cut(message) });

const pluginOf = (installation: PluginInstallation): Plugin | undefined =>
  installation.manifest === null
    ? undefined
    : { id: installation.manifest.id, name: installation.manifest.name };

/** Enabled now, declaring tools, with consent that covers the tools capability. */
const offersTools = (installation: PluginInstallation) =>
  pluginInstallationStatus(installation) === "enabled" &&
  (installation.manifest?.tools?.length ?? 0) > 0 &&
  installation.consent?.capabilities.includes(PLUGIN_TOOLS_CAPABILITY) === true;

interface PluginToolCallRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly context: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
}

export class PluginTools extends Context.Service<
  PluginTools,
  {
    /** The tool plugins enabled right now, for a session's credential to hold. */
    readonly grants: Effect.Effect<ReadonlyArray<PluginToolGrant>>;
    /** One page of the tools of granted plugins still enabled under the same registration. */
    readonly list: (
      grants: ReadonlyArray<PluginToolGrant>,
      options?: { readonly plugin?: string; readonly cursor?: string },
    ) => Effect.Effect<PluginToolsListResult>;
    /** Validates `input` against the tool's schema and calls it under the granted registration. */
    readonly call: (
      grants: ReadonlyArray<PluginToolGrant>,
      request: PluginToolCallRequest,
    ) => Effect.Effect<Schema.Json, PluginToolError>;
  }
>()("t3/plugins/PluginTools") {}

export const make = Effect.gen(function* () {
  const catalog = yield* PluginCatalog;
  // A registration's manifest cannot change: its bytes are checked before every fresh process.
  const prepared = new Map<
    PluginInstallationId,
    { readonly generation: number; readonly tools: PreparedPluginTools | undefined }
  >();
  let index: Index = { revision: -1, ids: [], byId: new Map() };
  // A session's grants are fixed for its credential, so their lookup is built once.
  const grantLookups = new WeakMap<
    ReadonlyArray<PluginToolGrant>,
    ReadonlyMap<PluginInstallationId, number>
  >();

  /**
   * The live tool plugins. Reading the catalogue and sorting happen once per
   * change to its records, never per request, so a request's own work is the
   * page it returns.
   */
  const current = Effect.gen(function* () {
    const revision = yield* catalog.revision;
    if (revision === index.revision) return index;
    const byId = new Map<string, Indexed>();
    for (const installation of (yield* catalog.list).installations) {
      const plugin = pluginOf(installation);
      // Ids are unique among registered plugins; the oldest installation wins otherwise.
      if (plugin !== undefined && offersTools(installation) && !byId.has(plugin.id))
        byId.set(plugin.id, { plugin, installation, nameBytes: jsonBytes(plugin) + 1 });
    }
    const live = new Map(
      [...byId.values()].map(({ installation }) => [installation.installationId, installation]),
    );
    for (const [installationId, cached] of prepared)
      if (live.get(installationId)?.generation !== cached.generation)
        prepared.delete(installationId);
    // Reading `revision` first means a change during the read rebuilds again next time.
    index = { revision, ids: [...byId.keys()].toSorted(), byId };
    return index;
  });

  const isGranted = (grants: ReadonlyArray<PluginToolGrant>, installation: PluginInstallation) => {
    let lookup = grantLookups.get(grants);
    if (lookup === undefined) {
      lookup = new Map(grants.map((grant) => [grant.installationId, grant.generation]));
      grantLookups.set(grants, lookup);
    }
    return lookup.get(installation.installationId) === installation.generation;
  };

  /** The installation's declared tools, prepared once per registration. */
  const toolsOf = Effect.fnUntraced(function* (installation: PluginInstallation, plugin: Plugin) {
    const cached = prepared.get(installation.installationId);
    if (cached?.generation === installation.generation) return cached.tools;
    const result = preparePluginTools(plugin, installation.manifest?.tools ?? []);
    // The loader refuses a manifest whose tools do not prepare, so this is not expected.
    if ("problem" in result)
      yield* Effect.logWarning("Plugin tools could not be prepared", {
        installationId: installation.installationId,
        problem: result.problem,
      });
    const tools = "problem" in result ? undefined : result;
    prepared.set(installation.installationId, { generation: installation.generation, tools });
    return tools;
  });

  const grants = current.pipe(
    Effect.map(({ byId }) =>
      [...byId.values()].map(({ installation: { installationId, generation } }) => ({
        installationId,
        generation,
      })),
    ),
  );

  const list = Effect.fn("PluginTools.list")(function* (
    grants: ReadonlyArray<PluginToolGrant>,
    options?: { readonly plugin?: string; readonly cursor?: string },
  ) {
    const { ids, byId } = yield* current;
    const cursor = options?.cursor;
    const only = options?.plugin;
    let from = cursor === undefined ? 0 : firstAfter(ids, cursor);
    let to = ids.length;
    if (only !== undefined) {
      const at = firstAfter(ids, only) - 1;
      [from, to] = at >= from && ids[at] === only ? [at, at + 1] : [0, 0];
    }

    // Every plugin fits a page on its own (the loader bounds its listing), so each page
    // makes progress and the whole result, envelope included, stays within the limit.
    // Only the plugins on the page, and the one after it, are prepared.
    const result: { tools: Array<PluginToolListing>; notInThisSession: Array<Plugin> } = {
      tools: [],
      notInThisSession: [],
    };
    let budget = PLUGIN_TOOL_LIMITS.maxListBytes - LIST_ENVELOPE_BYTES;
    let last: string | undefined;
    for (let position = from; position < to; position++) {
      const id = ids[position]!;
      const { plugin, installation, nameBytes } = byId.get(id)!;
      const granted = isGranted(grants, installation);
      const tools = granted ? yield* toolsOf(installation, plugin) : undefined;
      if (granted && tools === undefined) continue;
      const bytes = tools?.listingBytes ?? nameBytes;
      if (bytes > budget) return { ...result, ...(last === undefined ? {} : { nextCursor: last }) };
      budget -= bytes;
      last = id;
      if (tools === undefined) result.notInThisSession.push(plugin);
      else for (const tool of tools.tools.values()) result.tools.push(tool.listing);
    }
    return result satisfies PluginToolsListResult;
  });

  const call = Effect.fn("PluginTools.call")(function* (
    grants: ReadonlyArray<PluginToolGrant>,
    request: PluginToolCallRequest,
  ) {
    const parsed = parseQualifiedPluginToolName(request.tool);
    if (Option.isNone(parsed))
      return yield* toolError(
        "unknown-tool",
        `${request.tool} is not a plugin tool name. Use a tool value from plugin_tools_list.`,
      );
    const { pluginId, name } = parsed.value;
    const live = (yield* current).byId.get(pluginId);
    if (live === undefined)
      return yield* toolError("unavailable", `Plugin ${pluginId} is not enabled.`);
    const { plugin, installation } = live;
    if (!isGranted(grants, installation))
      return yield* toolError(
        "not-granted",
        `Plugin ${pluginId} was enabled after this session started. Start a new session to use its tools.`,
      );
    const tool = (yield* toolsOf(installation, plugin))?.tools.get(name);
    if (tool === undefined)
      return yield* toolError("unknown-tool", `Plugin ${pluginId} has no tool named ${name}.`);
    const validated = tool.validate(request.input ?? {});
    if (Exit.isFailure(validated))
      return yield* toolError(
        "invalid-input",
        `The input does not match ${request.tool}'s inputSchema: ${Option.match(
          Exit.findErrorOption(validated),
          { onNone: () => "unknown error", onSome: (error) => error.message },
        )}`,
      );
    const input = decodeJsonObject(validated.value);
    if (Exit.isFailure(input))
      return yield* toolError("invalid-input", "The input must be a JSON object.");
    const value = yield* catalog
      .invoke(
        installation.installationId,
        pluginToolHandlerName(name),
        { input: input.value, context: request.context },
        { timeout: `${tool.timeoutSeconds} seconds`, generation: installation.generation },
      )
      .pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "PluginCatalogError":
            case "PluginStoppedError":
            case "PluginNotEnabledError":
            case "PluginUnavailableError":
            case "PluginIncompatibleError":
              return toolError("unavailable", error.message);
            case "PluginTimeoutError":
              return toolError("timeout", error.message);
            default:
              return toolError("failed", error.message);
          }
        }),
      );
    if (jsonBytes(value) > PLUGIN_TOOL_LIMITS.maxResultBytes)
      return yield* toolError(
        "result-too-large",
        `${request.tool} returned more than ${PLUGIN_TOOL_LIMITS.maxResultBytes} bytes.`,
      );
    return value;
  });

  return PluginTools.of({ grants, list, call });
});

/** The position of the first id after `cursor` in sorted `ids`. */
const firstAfter = (ids: ReadonlyArray<string>, cursor: string) => {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ids[middle]! <= cursor) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const layer = Layer.effect(PluginTools, make);
