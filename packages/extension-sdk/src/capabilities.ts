import { assertId, copyJson, type Json, type ViewContext } from "./contracts.js";
import type { JsonObject } from "./environment.js";
import { compareVersions, parseVersion, rangeFloor } from "./semver.js";

export interface ApiMethod {
  readonly name: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly effect: "read" | "write";
  readonly requiredGrants: readonly string[];
}
export interface ApiStreamDefinition {
  readonly name: string;
  readonly inputSchema: JsonObject;
  readonly eventSchema: JsonObject;
  readonly requiredGrants: readonly string[];
}
export interface ApiDefinition {
  readonly id: string;
  readonly version: string;
  readonly methods?: readonly ApiMethod[];
  readonly streams?: readonly ApiStreamDefinition[];
}
export interface ApiRequirement {
  readonly id: string;
  readonly versionRange: string;
}
export interface PluginDependency {
  readonly pluginId: string;
  readonly versionRange: string;
  readonly apis: readonly ApiRequirement[];
}
export interface ApiInvocation {
  readonly id: string;
  readonly versionRange: string;
  readonly method: string;
  readonly input: Json;
  readonly context: ViewContext;
  readonly expectedGeneration?: number;
  readonly requestId?: string;
  /**
   * Session-validated `self` routing hint for client-provider-backed
   * contracts. Set only by the client runtime's ClientHost wrapper — callers
   * must not supply it; the wrapper overwrites any caller-supplied value.
   */
  readonly clientConnectionId?: string;
}
export interface ApiStreamInvocation {
  readonly id: string;
  readonly versionRange: string;
  readonly name: string;
  readonly input: Json;
  readonly context: ViewContext;
  readonly expectedGeneration?: number;
  readonly cursor?: string;
  readonly clientConnectionId?: string;
}
export type ApiStreamEventType = "snapshot" | "data" | "reset" | "closed";
export interface ApiStreamEvent {
  readonly type: ApiStreamEventType;
  readonly value: Json;
  readonly cursor?: string;
}
export interface ApiStreamFrame extends ApiStreamEvent {
  readonly streamId: string;
  readonly sequence: number;
}
export interface ApiSelection {
  readonly id: string;
  readonly providerId: string;
  readonly fallbackProviderIds: readonly string[];
}
export interface ApiUnavailableReason {
  readonly code: string;
  readonly detail: string;
  readonly relatedIds: readonly string[];
}
export interface ApiDiscovery {
  readonly id: string;
  readonly version: string;
  readonly providerId: string;
  readonly pluginId?: string;
  readonly generation: number;
  readonly health: "starting" | "ready" | "unavailable" | "failed";
  readonly selected: boolean;
  readonly reason?: ApiUnavailableReason;
}
export interface ApiClient {
  invokeApi(request: ApiInvocation, signal: AbortSignal): Promise<Json>;
  subscribeApi(request: ApiStreamInvocation, signal: AbortSignal): AsyncIterable<ApiStreamFrame>;
  discoverApis(context: ViewContext, signal: AbortSignal): Promise<readonly ApiDiscovery[]>;
}
/**
 * `ClientHost.resumableStreams`: host-managed resumption for streams whose
 * every subscription opens with a full snapshot (`RESUMABLE_API_STREAMS`,
 * which names the version that added each stream).
 * The host follows its own transport, as native subscriptions do: a dropped
 * connection suspends the iterable, and each new transport session opens
 * exactly one fresh subscription for the same request. A resumed subscription
 * restarts at `sequence` 1 with a snapshot; treat it as a new stream and
 * reconcile the snapshot instead of appending it. Completion, domain errors
 * and cancellation still end the iterable and are never retried.
 */
export interface ResumableApiStreams {
  /**
   * 2 also resumes `t3.terminal/sessions#list`, 3 `t3.workspace/changes#subscribeChanges`,
   * 4 `t3.browser/sessions#events`; check with `resolveResumableStreams(host, stream)`.
   */
  readonly version: 1 | 2 | 3 | 4;
  subscribeApi(
    request: ApiStreamInvocation,
    signal: AbortSignal,
    options?: ResumableStreamOptions,
  ): AsyncIterable<ApiStreamFrame>;
}
export interface ResumableStreamOptions {
  /**
   * Runs whenever the iterable is waiting for a transport session, after
   * every frame received before that point. That includes the wait before
   * the first connection: it can fire before any frame arrives, so show
   * "Reconnecting…" only once the stream has been live, and keep your
   * connecting state otherwise. It can also fire more than once for one
   * outage (the transport failing, then its session being torn down), so
   * make the handler idempotent. The next snapshot ends the wait. Hosts that
   * predate it never call it; then a resumed snapshot is the only sign of
   * the gap.
   */
  readonly onSuspended?: () => void;
}
/**
 * `id#stream` pairs a host resumes, each with the `resumableStreams` version
 * that added it; a host refuses every other stream and every newer one.
 */
export const RESUMABLE_API_STREAMS: Readonly<Record<string, number>> = {
  "t3.terminal/output-events#subscribe": 1,
  "t3.terminal/sessions#list": 2,
  "t3.workspace/changes#subscribeChanges": 3,
  "t3.browser/sessions#events": 4,
};
/**
 * The host's stream resumption when it offers version 1 or later — or, given
 * an `id#stream`, the version that added that stream — else null (keep your
 * own recovery).
 */
export function resolveResumableStreams(
  host: { readonly resumableStreams?: unknown },
  stream?: string,
): ResumableApiStreams | null {
  const member: unknown = host.resumableStreams;
  if (!member || typeof member !== "object") return null;
  const required =
    stream === undefined
      ? 1
      : Object.hasOwn(RESUMABLE_API_STREAMS, stream)
        ? RESUMABLE_API_STREAMS[stream]!
        : Infinity;
  const { version, subscribeApi } = member as Record<string, unknown>;
  return typeof version === "number" && version >= required && typeof subscribeApi === "function"
    ? (member as ResumableApiStreams)
    : null;
}
export type ApiMethodTypes = Record<string, { input: Json; output: Json }>;
/**
 * A member a minor release added after `baseline`: a whole method (`method`
 * alone), a whole stream (`stream`), an optional method input (`input`), or an
 * optional method output or stream event member (`output`). `bindApi` and
 * `bindStreamApi` guard methods, streams and inputs; outputs need no guard,
 * because a consumer on the baseline already has to treat the member as
 * possibly absent.
 */
export type ApiAddition =
  | {
      /** The release that added the member. */
      readonly version: string;
      readonly method: string;
      /**
       * Dotted input path; `[]` steps into array items, as in `"actions[].keepOpen"`.
       * Omitted when the release added the method itself.
       */
      readonly input?: string;
    }
  | {
      /** The release that added the stream. */
      readonly version: string;
      readonly stream: string;
    }
  | {
      readonly version: string;
      /** A method, or a stream whose event carries the member. */
      readonly method: string;
      /** Dotted output (or event) path, in the same form as `input`. */
      readonly output: string;
    };
/** Phantom method types accompany an immutable, serializable runtime descriptor. */
export interface TypedApi<T extends ApiMethodTypes> {
  readonly definition: ApiDefinition;
  /** See `defineApi`. */
  readonly baseline?: string;
  readonly additions?: readonly ApiAddition[];
  readonly types?: T;
}
/**
 * `bindApi` refused a call using a member newer than the binding's range
 * guarantees. Probe the host version (`discoverApis`), then bind at the
 * member's range.
 */
export class ApiVersionError extends Error {
  override readonly name = "ApiVersionError";
  readonly code = "api-version-not-negotiated";
}

function hasInput(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined;
  if (value === null || typeof value !== "object") return false;
  const [head, ...rest] = path as [string, ...string[]];
  const key = head.endsWith("[]") ? head.slice(0, -2) : head;
  const child = (value as Record<string, unknown>)[key];
  if (!head.endsWith("[]")) return hasInput(child, rest);
  return Array.isArray(child) && child.some((item) => hasInput(item, rest));
}
interface ApiNegotiation {
  readonly baseline?: string;
  readonly additions?: readonly ApiAddition[];
}
function negotiated(definition: ApiDefinition, options: ApiNegotiation): ApiNegotiation {
  if (options.baseline === undefined) {
    if (options.additions?.length) throw new Error("API additions need a baseline");
    return {};
  }
  // The guard only orders plain X.Y.Z versions; see semver.ts.
  const version = parseVersion(definition.version);
  if (!version)
    throw new Error("An API with a baseline needs a plain X.Y.Z version: " + definition.version);
  const baseline = parseVersion(options.baseline);
  if (!baseline || baseline[0] !== version[0] || compareVersions(baseline, version) > 0)
    throw new Error("API baseline must be an earlier plain X.Y.Z version of the same major");
  const additions = (options.additions ?? []).map((addition) => ({ ...addition }));
  if (compareVersions(baseline, version) < 0 && additions.length === 0)
    throw new Error("An API baseline below the current version must list its additions");
  for (const addition of additions) {
    const added = parseVersion(addition.version);
    if (!added)
      throw new Error("An API addition needs a plain X.Y.Z version: " + JSON.stringify(addition));
    const path =
      "input" in addition ? addition.input : "output" in addition ? addition.output : undefined;
    const owners =
      "stream" in addition
        ? []
        : [
            ...(definition.methods ?? []),
            ...("output" in addition ? (definition.streams ?? []) : []),
          ];
    if (
      compareVersions(added, baseline) <= 0 ||
      compareVersions(added, version) > 0 ||
      ("stream" in addition
        ? !definition.streams?.some((stream) => stream.name === addition.stream)
        : !owners.some((owner) => owner.name === addition.method)) ||
      ("output" in addition && typeof path !== "string") ||
      (path !== undefined &&
        (typeof path !== "string" ||
          !/^[A-Za-z_$][\w$]*(\[\])?(\.[A-Za-z_$][\w$]*(\[\])?)*$/.test(path)))
    )
      throw new Error("Invalid API addition: " + JSON.stringify(addition));
  }
  return { baseline: options.baseline, additions };
}
/**
 * `baseline` is the oldest version of this major that `requireApi` and
 * `bindApi` ask for by default. Set it when a minor release only adds
 * optional members, methods or streams, so existing consumers keep loading on
 * older hosts, and list every such member in `additions` (a new method is an
 * addition without `input`): a binding whose range admits a version before a
 * method, stream or input addition refuses calls that use it with
 * `ApiVersionError`, so a pack cannot declare the baseline and ship the new
 * member unprobed. The version, baseline and additions are plain `X.Y.Z`, and
 * only `X.Y.Z`, `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` and `>=X.Y.Z <A.B.C` bindings
 * can use additions; any other range refuses them.
 */
export function defineApi<T extends ApiMethodTypes>(
  definition: ApiDefinition,
  options: ApiNegotiation = {},
): TypedApi<T> {
  const validated = validateApiDefinition(definition);
  return { definition: validated, ...negotiated(validated, options) };
}
type GuardedAddition = Exclude<ApiAddition, { readonly output: string }>;
/** Guarded additions `versionRange` does not guarantee; see `defineApi`. */
function unnegotiatedAdditions(
  api: { readonly additions?: readonly ApiAddition[] },
  versionRange: string,
): readonly GuardedAddition[] {
  const floor = rangeFloor(versionRange);
  return (api.additions ?? []).filter((addition): addition is GuardedAddition => {
    // Output additions need no guard; see `ApiAddition`.
    if ("output" in addition) return false;
    const added = parseVersion(addition.version);
    return !floor || !added || compareVersions(floor, added) < 0;
  });
}
/** The range a consumer asks for when it names none: `^baseline`, else `^version`. */
export function defaultVersionRange(api: {
  readonly definition: ApiDefinition;
  readonly baseline?: string;
}): string {
  return "^" + (api.baseline ?? api.definition.version);
}
export function bindApi<T extends ApiMethodTypes>(
  api: TypedApi<T>,
  client: Pick<ApiClient, "invokeApi">,
  context: ViewContext,
  versionRange = defaultVersionRange(api),
) {
  const unnegotiated = unnegotiatedAdditions(api, versionRange);
  return {
    invoke<K extends keyof T & string>(
      method: K,
      input: T[K]["input"],
      signal: AbortSignal,
    ): Promise<T[K]["output"]> {
      const addition = unnegotiated.find(
        (item): item is Extract<GuardedAddition, { method: string }> =>
          "method" in item &&
          item.method === method &&
          (item.input === undefined || hasInput(input, item.input.split("."))),
      );
      if (addition)
        return Promise.reject(
          new ApiVersionError(
            `${api.definition.id}#${method}${addition.input === undefined ? "" : " " + addition.input} needs ^${addition.version}, ` +
              `but this binding asks for ${versionRange}; probe the host version, then bind at ^${addition.version}`,
          ),
        );
      return client.invokeApi(
        { id: api.definition.id, versionRange, method, input, context },
        signal,
      ) as Promise<T[K]["output"]>;
    },
  };
}
export type ApiStreamTypes = Record<string, { input: Json; event: Json }>;
/** Public stream types accompany the descriptor validated by the host at delivery. */
export interface TypedStreamApi<T extends ApiStreamTypes> {
  readonly definition: ApiDefinition;
  /** See `defineApi`. */
  readonly baseline?: string;
  readonly additions?: readonly ApiAddition[];
  readonly streamTypes?: T;
}
export type TypedApiStreamFrame<T extends Json> = Omit<ApiStreamFrame, "value"> & {
  readonly value: T;
};
/** `baseline` and `additions` work as they do for `defineApi`. */
export function defineStreamApi<T extends ApiStreamTypes>(
  definition: ApiDefinition,
  options: ApiNegotiation = {},
): TypedStreamApi<T> {
  const validated = validateApiDefinition(definition);
  if (!validated.streams?.length) throw new Error("Expected API stream definitions");
  return { definition: validated, ...negotiated(validated, options) };
}
/**
 * Retain the host iterable so return(), cancellation and backpressure keep their ownership.
 * `resume: "fresh-snapshot"` subscribes through `ClientHost.resumableStreams`; on a host
 * without it the iterable fails with `ApiVersionError`, so check
 * `resolveResumableStreams(host, "id#stream")` first.
 */
export function bindStreamApi<T extends ApiStreamTypes>(
  api: TypedStreamApi<T>,
  client: Pick<ApiClient, "subscribeApi"> & { readonly resumableStreams?: unknown },
  context: ViewContext,
  versionRange = defaultVersionRange(api),
) {
  const unnegotiated = unnegotiatedAdditions(api, versionRange);
  return {
    subscribe<K extends keyof T & string>(
      name: K,
      input: T[K]["input"],
      signal: AbortSignal,
      options?: {
        readonly cursor?: string;
        readonly expectedGeneration?: number;
        readonly resume?: "fresh-snapshot";
        /** With `resume`: see `ResumableStreamOptions.onSuspended`. */
        readonly onSuspended?: () => void;
      },
    ): AsyncIterable<TypedApiStreamFrame<T[K]["event"]>> {
      const addition = unnegotiated.find((item) => "stream" in item && item.stream === name);
      if (addition)
        throw new ApiVersionError(
          `${api.definition.id} stream ${name} needs ^${addition.version}, ` +
            `but this binding asks for ${versionRange}; probe the host version, then bind at ^${addition.version}`,
        );
      let subscribeApi = client.subscribeApi.bind(client);
      if (options?.resume === "fresh-snapshot") {
        const resumable = resolveResumableStreams(client);
        if (!resumable) {
          const error = new ApiVersionError(
            `${api.definition.id}#${name} asked for host stream resumption, which this host does not offer`,
          );
          return {
            [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
          };
        }
        const onSuspended = options.onSuspended;
        subscribeApi = onSuspended
          ? (request, signal) => resumable.subscribeApi(request, signal, { onSuspended })
          : resumable.subscribeApi.bind(resumable);
      }
      return subscribeApi(
        {
          id: api.definition.id,
          versionRange,
          name,
          input,
          context,
          ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options?.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: options.expectedGeneration }),
        },
        signal,
      ) as AsyncIterable<TypedApiStreamFrame<T[K]["event"]>>;
    },
  };
}

/** A call the host refused because the installation lacks a grant. */
export interface GrantDenial {
  readonly grant: string;
  /** The line a pack shows for it: names the permission and where to grant it. */
  readonly message: string;
}

/** The actionable line for a missing grant; only the user grants it, in Settings. */
export function grantDenialMessage(grant: string): string {
  return `Needs permission ${grant}. Grant it in Settings → Extensions.`;
}

// The broker's wording is `API capability denied: <grant>`; hosts may wrap it,
// so the grant ends at its last name character, not at trailing punctuation.
const CAPABILITY_DENIED = /capability denied: ([\w.\-/]*[\w\-/])/;

/**
 * A thrown invoke or stream error → the grant it was denied, or null for any
 * other failure. Use at a call's catch so the view names the fix instead of
 * showing the raw broker text.
 */
export function describeGrantDenial(error: unknown): GrantDenial | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const grant = CAPABILITY_DENIED.exec(text)?.[1];
  return grant ? { grant, message: grantDenialMessage(grant) } : null;
}

export function validateRangeText(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("Invalid API or dependency version range");
}
export function validateApiRequirement(value: ApiRequirement): ApiRequirement {
  const item = copyJson(value);
  assertId(item.id);
  validateRangeText(item.versionRange);
  return item;
}
export function validateApiSchema(value: unknown): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected API JSON schema");
  const walk = (node: Json): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#")))
        throw new Error("API schemas cannot use external references");
      walk(child);
    }
  };
  walk(copyJson(value) as Json);
}
export function validateApiDefinition(value: ApiDefinition): ApiDefinition {
  const api = copyJson(value);
  if (!api || typeof api !== "object" || Array.isArray(api))
    throw new Error("Invalid API definition");
  assertId(api.id);
  if (
    typeof api.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(api.version)
  )
    throw new Error("Invalid API version");
  if (
    (!Array.isArray(api.methods) && api.methods !== undefined) ||
    (!Array.isArray(api.streams) && api.streams !== undefined) ||
    (!api.methods?.length && !api.streams?.length) ||
    (api.methods?.length ?? 0) > 32 ||
    (api.streams?.length ?? 0) > 32
  )
    throw new Error("Invalid API methods");
  const names = new Set<string>();
  for (const method of api.methods ?? []) {
    if (!method || typeof method !== "object") throw new Error("Invalid API method");
    if (
      typeof method.name !== "string" ||
      !/^(?=.{1,80}$)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(method.name) ||
      names.has(method.name)
    )
      throw new Error("Duplicate or invalid API method");
    names.add(method.name);
    if (method.effect !== "read" && method.effect !== "write")
      throw new Error("Invalid API effect");
    validateApiSchema(method.inputSchema);
    validateApiSchema(method.outputSchema);
    if (
      !Array.isArray(method.requiredGrants) ||
      method.requiredGrants.length > 16 ||
      new Set(method.requiredGrants).size !== method.requiredGrants.length
    )
      throw new Error("Invalid API grants");
    method.requiredGrants.forEach(assertId);
  }
  for (const stream of api.streams ?? []) {
    if (
      !stream ||
      typeof stream.name !== "string" ||
      !/^[a-z][a-zA-Z0-9]{0,79}$/.test(stream.name) ||
      names.has(stream.name)
    )
      throw new Error("Duplicate or invalid API stream");
    names.add(stream.name);
    validateApiSchema(stream.inputSchema);
    validateApiSchema(stream.eventSchema);
    if (
      !Array.isArray(stream.requiredGrants) ||
      stream.requiredGrants.length > 16 ||
      new Set(stream.requiredGrants).size !== stream.requiredGrants.length
    )
      throw new Error("Invalid API stream grants");
    stream.requiredGrants.forEach(assertId);
  }
  return api;
}
