import { assertId, copyJson, type Json, type ViewContext } from "./contracts.js";
import type { JsonObject } from "./environment.js";

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
export type ApiMethodTypes = Record<string, { input: Json; output: Json }>;
/** Phantom method types accompany an immutable, serializable runtime descriptor. */
export interface TypedApi<T extends ApiMethodTypes> {
  readonly definition: ApiDefinition;
  readonly types?: T;
}
export function defineApi<T extends ApiMethodTypes>(definition: ApiDefinition): TypedApi<T> {
  return { definition: validateApiDefinition(definition) };
}
export function bindApi<T extends ApiMethodTypes>(
  api: TypedApi<T>,
  client: Pick<ApiClient, "invokeApi">,
  context: ViewContext,
  versionRange = "^" + api.definition.version,
) {
  return {
    invoke<K extends keyof T & string>(
      method: K,
      input: T[K]["input"],
      signal: AbortSignal,
    ): Promise<T[K]["output"]> {
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
  readonly streamTypes?: T;
}
export type TypedApiStreamFrame<T extends Json> = Omit<ApiStreamFrame, "value"> & {
  readonly value: T;
};
export function defineStreamApi<T extends ApiStreamTypes>(
  definition: ApiDefinition,
): TypedStreamApi<T> {
  const validated = validateApiDefinition(definition);
  if (!validated.streams?.length) throw new Error("Expected API stream definitions");
  return { definition: validated };
}
/** Retain the host iterable so return(), cancellation and backpressure keep their ownership. */
export function bindStreamApi<T extends ApiStreamTypes>(
  api: TypedStreamApi<T>,
  client: Pick<ApiClient, "subscribeApi">,
  context: ViewContext,
  versionRange = "^" + api.definition.version,
) {
  return {
    subscribe<K extends keyof T & string>(
      name: K,
      input: T[K]["input"],
      signal: AbortSignal,
      options?: { readonly cursor?: string; readonly expectedGeneration?: number },
    ): AsyncIterable<TypedApiStreamFrame<T[K]["event"]>> {
      return client.subscribeApi(
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
