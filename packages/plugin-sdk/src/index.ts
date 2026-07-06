import type * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type {
  PluginCapability,
  PluginId,
  PluginLockfile,
  PluginLockfilePlugin,
  PluginLockfileSource,
  PluginManifest,
  PluginManifestEntries,
  PluginState,
} from "@t3tools/contracts/plugin";
export { HOST_API_VERSION, hostApiSatisfies } from "@t3tools/contracts/plugin";

export type PluginRpcScope = "read" | "operate";
export type PluginReadiness = "requires-ready" | "always";

export interface PluginLogger {
  readonly debug: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
  readonly info: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
  readonly warn: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
  readonly error: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
}

export interface PluginHostConfig {
  readonly appVersion: string;
  readonly hostApiVersion: string;
  readonly dataDir: string;
  readonly logger: PluginLogger;
}

export interface PluginCapabilityUnavailable {
  readonly _tag: "PluginCapabilityUnavailable";
  readonly capability: string;
  readonly message: string;
}

export interface AgentsCapability {
  readonly list: Effect.Effect<ReadonlyArray<unknown>>;
}

export interface VcsCapability {
  readonly status: (input: { readonly cwd: string }) => Effect.Effect<unknown>;
}

export interface TerminalsCapability {
  readonly open: (input: unknown) => Effect.Effect<unknown>;
}

export interface DatabaseCapability {
  readonly sql: SqlClient.SqlClient;
}

export interface ProjectionsReadCapability {
  readonly getSnapshot: (input: unknown) => Effect.Effect<unknown>;
}

export interface EnvironmentsReadCapability {
  readonly list: Effect.Effect<ReadonlyArray<unknown>>;
}

export interface SecretsCapability {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void>;
}

export interface HttpCapability {
  readonly baseUrl: string | null;
}

export interface SourceControlCapability {
  readonly listPullRequests: (input: unknown) => Effect.Effect<ReadonlyArray<unknown>>;
}

export interface TextGenerationCapability {
  readonly generateText: (input: unknown) => Effect.Effect<string>;
}

export interface PluginHostApi {
  readonly hostApiVersion: string;
  readonly config: PluginHostConfig;
  readonly agents: Effect.Effect<AgentsCapability, PluginCapabilityUnavailable>;
  readonly vcs: Effect.Effect<VcsCapability, PluginCapabilityUnavailable>;
  readonly terminals: Effect.Effect<TerminalsCapability, PluginCapabilityUnavailable>;
  readonly database: Effect.Effect<DatabaseCapability, PluginCapabilityUnavailable>;
  readonly projectionsRead: Effect.Effect<ProjectionsReadCapability, PluginCapabilityUnavailable>;
  readonly environmentsRead: Effect.Effect<EnvironmentsReadCapability, PluginCapabilityUnavailable>;
  readonly secrets: Effect.Effect<SecretsCapability, PluginCapabilityUnavailable>;
  readonly http: Effect.Effect<HttpCapability, PluginCapabilityUnavailable>;
  readonly sourceControl: Effect.Effect<SourceControlCapability, PluginCapabilityUnavailable>;
  readonly textGeneration: Effect.Effect<TextGenerationCapability, PluginCapabilityUnavailable>;
}

export interface PluginRpcContext {
  readonly pluginId: string;
  readonly logger: PluginLogger;
}

export interface PluginRpcDescriptor {
  readonly method: string;
  readonly scope: PluginRpcScope;
  readonly readiness?: PluginReadiness | undefined;
  readonly handler: (payload: unknown, ctx: PluginRpcContext) => Effect.Effect<unknown, Error>;
}

export interface PluginStreamDescriptor {
  readonly method: string;
  readonly scope: PluginRpcScope;
  readonly readiness?: PluginReadiness | undefined;
  readonly handler: (payload: unknown, ctx: PluginRpcContext) => Effect.Effect<unknown, Error>;
}

export interface PluginHttpDescriptor {
  readonly method: string;
  readonly path: string;
  readonly auth: "public" | "token";
  readonly handler: (request: unknown, ctx: PluginRpcContext) => Effect.Effect<unknown, Error>;
}

export interface PluginServiceContext {
  readonly pluginId: string;
  readonly logger: PluginLogger;
}

export interface PluginServiceDescriptor {
  readonly name: string;
  readonly run: (ctx: PluginServiceContext) => Effect.Effect<void, Error>;
}

export interface PluginMigration {
  readonly version: number;
  readonly name: string;
  readonly up: Effect.Effect<void, Error, SqlClient.SqlClient>;
}

export interface PluginRegistration {
  readonly migrations?: ReadonlyArray<PluginMigration> | undefined;
  readonly recover?: (() => Effect.Effect<void, Error>) | undefined;
  readonly rpc?: ReadonlyArray<PluginRpcDescriptor> | undefined;
  readonly streams?: ReadonlyArray<PluginStreamDescriptor> | undefined;
  readonly http?: ReadonlyArray<PluginHttpDescriptor> | undefined;
  readonly services?: ReadonlyArray<PluginServiceDescriptor> | undefined;
}

export interface PluginDefinition {
  readonly register:
    | ((hostApi: PluginHostApi) => Effect.Effect<PluginRegistration, Error>)
    | ((hostApi: PluginHostApi) => Promise<PluginRegistration>)
    | ((hostApi: PluginHostApi) => PluginRegistration);
}

export function definePlugin<const Definition extends PluginDefinition>(
  definition: Definition,
): Definition {
  return definition;
}
