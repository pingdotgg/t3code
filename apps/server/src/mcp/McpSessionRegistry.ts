import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly readProviderSession: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<McpProviderSessionConfig | undefined>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderInstance: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly providerSessions: ReadonlyMap<string, McpProviderSessionConfig>;
}

export interface McpSessionRegistryOptions {
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

// A provider crash can bypass teardown. This is a backstop, not a normal
// session lifetime: active credentials remain valid until explicitly revoked.
const DEFAULT_MAXIMUM_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const providerSessionKey = (threadId: ThreadId, providerInstanceId: ProviderInstanceId): string =>
  JSON.stringify([threadId, providerInstanceId]);

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(),
    providerSessions: new Map(),
  });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneExpired = (current: RegistryState, timestamp: number): RegistryState => {
    const hasExpiredRecord = Array.from(current.records.values()).some(
      (record) => timestamp > record.scope.expiresAt,
    );
    if (!hasExpiredRecord) return current;
    const records = new Map(
      Array.from(current.records).filter(([, record]) => timestamp <= record.scope.expiresAt),
    );
    const activeProviderSessionIds = new Set(
      Array.from(records.values(), (record) => record.scope.providerSessionId),
    );
    return {
      records,
      providerSessions: new Map(
        Array.from(current.providerSessions).filter(([, config]) =>
          activeProviderSessionIds.has(config.providerSessionId),
        ),
      ),
    };
  };

  const revokeWhere = (
    current: RegistryState,
    predicate: (record: CredentialRecord) => boolean,
  ): RegistryState => {
    const records = new Map(Array.from(current.records).filter(([, record]) => !predicate(record)));
    if (records.size === current.records.size) return current;
    const activeProviderSessionIds = new Set(
      Array.from(records.values(), (record) => record.scope.providerSessionId),
    );
    return {
      records,
      providerSessions: new Map(
        Array.from(current.providerSessions).filter(([, config]) =>
          activeProviderSessionIds.has(config.providerSessionId),
        ),
      ),
    };
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const expiresAt = issuedAt + maximumLifetimeMs;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set(["preview"]),
        issuedAt,
        expiresAt,
      };
      const config: McpProviderSessionConfig = {
        environmentId,
        threadId: scope.threadId,
        providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        endpoint,
        authorizationHeader: `Bearer ${rawToken}`,
      };
      yield* SynchronizedRef.update(state, (current) => {
        const pruned = pruneExpired(current, issuedAt);
        const replaced = revokeWhere(
          pruned,
          (record) =>
            record.scope.threadId === scope.threadId &&
            record.scope.providerInstanceId === scope.providerInstanceId,
        );
        const records = new Map(replaced.records);
        records.set(tokenHash, { tokenHash, scope });
        const providerSessions = new Map(replaced.providerSessions);
        providerSessions.set(providerSessionKey(scope.threadId, scope.providerInstanceId), config);
        return { records, providerSessions };
      });
      return {
        config,
        expiresAt,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, (current) => {
        const pruned = pruneExpired(current, timestamp);
        return [pruned.records.get(tokenHash)?.scope, pruned] as const;
      });
    },
  );

  return McpSessionRegistry.of({
    issue,
    readProviderSession: (threadId, providerInstanceId) =>
      currentTimeMillis.pipe(
        Effect.flatMap((timestamp) =>
          SynchronizedRef.modify(state, (current) => {
            const pruned = pruneExpired(current, timestamp);
            return [
              pruned.providerSessions.get(providerSessionKey(threadId, providerInstanceId)),
              pruned,
            ] as const;
          }),
        ),
      ),
    resolve,
    revokeProviderInstance: Effect.fn("McpSessionRegistry.revokeProviderInstance")(
      function* (threadId, providerInstanceId) {
        yield* SynchronizedRef.update(state, (current) =>
          revokeWhere(
            current,
            (record) =>
              record.scope.threadId === threadId &&
              record.scope.providerInstanceId === providerInstanceId,
          ),
        );
      },
    ),
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* SynchronizedRef.update(state, (current) =>
          revokeWhere(current, (record) => record.scope.providerSessionId === providerSessionId),
        );
      },
    ),
    revokeAll: SynchronizedRef.set(state, { records: new Map(), providerSessions: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    registry.revokeAll.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (activeMcpSessionRegistry === registry) {
            activeMcpSessionRegistry = undefined;
          }
        }),
      ),
    ),
);

export const layer: Layer.Layer<
  McpSessionRegistry,
  never,
  Crypto.Crypto | ServerEnvironment | HttpServer.HttpServer
> = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.issue(request)
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const readActiveMcpProviderSession = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): Effect.Effect<McpProviderSessionConfig | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.readProviderSession(threadId, providerInstanceId)
    : Effect.succeed(undefined);

export const revokeActiveMcpProviderSession = (providerSessionId: string): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.revokeProviderSession(providerSessionId)
    : Effect.void;

export const revokeActiveMcpProviderInstance = (
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.revokeProviderInstance(threadId, providerInstanceId)
    : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
