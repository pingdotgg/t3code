import type {
  PluginCommandName,
  PluginId,
  PluginManifest,
  PluginSubscriptionEvent,
  PluginUiPlacementId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export interface PluginCollection<A> {
  readonly list: () => Effect.Effect<ReadonlyArray<A>, PluginStoreError>;
  readonly get: (documentId: string) => Effect.Effect<A | null, PluginStoreError>;
  readonly upsert: (documentId: string, document: A) => Effect.Effect<void, PluginStoreError>;
  readonly delete: (documentId: string) => Effect.Effect<void, PluginStoreError>;
}

export interface PluginDocumentStore {
  readonly registerCollection: <A, I>(
    collection: string,
    schema: Schema.Codec<A, I>,
  ) => Effect.Effect<PluginCollection<A>, PluginStoreError>;
}

export interface PluginCommandRegistration<I = unknown, O = unknown> {
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly handler: (input: I) => Effect.Effect<O, Error>;
}

export interface PluginCommandRegistryApi {
  readonly register: <I, O>(
    command: PluginCommandName,
    registration: PluginCommandRegistration<I, O>,
  ) => Effect.Effect<void>;
}

export interface PluginUiContributionApi {
  readonly setPlacementBadgeProvider: (
    placementId: PluginUiPlacementId,
    provider: () => Effect.Effect<number, Error>,
  ) => Effect.Effect<void>;
}

export interface PluginRuntimeApi {
  readonly createAndSendThread: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly prompt: string;
  }) => Effect.Effect<{ readonly threadId: ThreadId }, PluginRuntimeError>;
}

export interface PluginEventApi {
  readonly publish: (
    event: Omit<PluginSubscriptionEvent, "pluginId" | "createdAt">,
  ) => Effect.Effect<void>;
}

export interface PluginActivationContext {
  readonly pluginId: PluginId;
  readonly store: PluginDocumentStore;
  readonly commands: PluginCommandRegistryApi;
  readonly ui: PluginUiContributionApi;
  readonly runtime: PluginRuntimeApi;
  readonly events: PluginEventApi;
}

export interface ServerPlugin {
  readonly manifest: PluginManifest;
  readonly activate: (ctx: PluginActivationContext) => Effect.Effect<void, Error, Scope.Scope>;
}

export function defineServerPlugin(plugin: ServerPlugin): ServerPlugin {
  return plugin;
}

export class PluginStoreError extends Error {
  override readonly name = "PluginStoreError";
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}

export class PluginRuntimeError extends Error {
  override readonly name = "PluginRuntimeError";
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}
