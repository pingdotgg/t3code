import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  /** Credentials remain valid until their owning thread/session lifecycle revokes them. */
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  /** Atomically replaces every credential owned by the thread. */
  readonly rotate: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
    audience: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly audience: string;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly scope: McpInvocationContext.McpInvocationScope;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

type ResolveOutcome =
  | { readonly type: "missing" }
  | {
      readonly type: "resolved" | "audience_denied";
      readonly scope: McpInvocationContext.McpInvocationScope;
    };

export interface McpSessionRegistryOptions {
  readonly now?: () => number;
  readonly audit?: (event: McpCredentialAuditEvent) => void;
}

export type McpCredentialAuditEvent =
  | {
      readonly type: "issued" | "rotated";
      readonly credentialId: string;
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerSessionId: string;
      readonly capabilities: ReadonlyArray<McpInvocationContext.McpCapability>;
      readonly audience: string;
      readonly issuedAt: number;
    }
  | {
      readonly type: "resolved" | "audience_denied";
      readonly credentialId: string;
      readonly providerSessionId: string;
      readonly audience: string;
      readonly occurredAt: number;
    }
  | {
      readonly type: "revoked";
      readonly credentialIds: ReadonlyArray<string>;
      readonly reason: "provider_session" | "thread" | "rotation" | "all";
      readonly occurredAt: number;
    };

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

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
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const audit = (event: McpCredentialAuditEvent) =>
    Effect.sync(() => {
      options.audit?.(event);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("mcp.credential-audit-hook-failed", {
          eventType: event.type,
          cause,
        }),
      ),
    );
  const audience = `urn:t3-code:mcp:${environmentId}`;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const mint = Effect.fn("McpSessionRegistry.mint")(function* (
    request: McpCredentialRequest,
    rotation: boolean,
  ) {
    const issuedAt = yield* currentTimeMillis;
    const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const credentialId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    const tokenHash = yield* hashToken(rawToken);
    const scope: McpInvocationContext.McpInvocationScope = {
      credentialId,
      environmentId,
      threadId: ThreadId.make(request.threadId),
      providerSessionId,
      providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
      capabilities: new Set(
        McpInvocationContext.ALL_MCP_CAPABILITIES.filter((capability) =>
          request.capabilities.has(capability),
        ),
      ),
      audience,
      issuedAt,
    };
    const revokedCredentialIds = yield* SynchronizedRef.modify(state, ({ records }) => {
      const next = new Map(records);
      const revoked = rotation
        ? Array.from(next)
            .filter(([, record]) => record.scope.threadId === request.threadId)
            .map(([hash, record]) => {
              next.delete(hash);
              return record.scope.credentialId;
            })
        : [];
      next.set(tokenHash, { scope });
      return [revoked, { records: next }] as const;
    });
    if (revokedCredentialIds.length > 0) {
      yield* audit({
        type: "revoked",
        credentialIds: revokedCredentialIds,
        reason: "rotation",
        occurredAt: issuedAt,
      });
    }
    const capabilities = [...scope.capabilities].toSorted();
    yield* audit({
      type: rotation ? "rotated" : "issued",
      credentialId,
      threadId: scope.threadId,
      providerInstanceId: scope.providerInstanceId,
      providerSessionId,
      capabilities,
      audience,
      issuedAt,
    });
    return {
      config: {
        credentialId,
        environmentId,
        threadId: scope.threadId,
        providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        endpoint,
        authorizationHeader: `Bearer ${rawToken}`,
        audience,
        capabilities,
        issuedAt,
      },
    };
  });

  const issue: McpSessionRegistryShape["issue"] = (request) => mint(request, false);
  const rotate: McpSessionRegistryShape["rotate"] = (request) => mint(request, true);

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken, requestedAudience) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const now = yield* currentTimeMillis;
      const outcome = yield* SynchronizedRef.modify(
        state,
        ({ records }): readonly [ResolveOutcome, RegistryState] => {
          const record = records.get(tokenHash);
          if (record === undefined) {
            return [{ type: "missing" }, { records }];
          }
          if (record.scope.audience !== requestedAudience) {
            return [{ type: "audience_denied", scope: record.scope }, { records }];
          }
          return [{ type: "resolved", scope: record.scope }, { records }];
        },
      );
      if (outcome.type === "missing") return undefined;
      yield* audit({
        type: outcome.type,
        credentialId: outcome.scope.credentialId,
        providerSessionId: outcome.scope.providerSessionId,
        audience: requestedAudience,
        occurredAt: now,
      });
      return outcome.type === "resolved" ? outcome.scope : undefined;
    },
  );

  const revokeWhere = (
    predicate: (record: CredentialRecord) => boolean,
    reason: Extract<McpCredentialAuditEvent, { type: "revoked" }>["reason"],
  ) =>
    Effect.gen(function* () {
      const now = yield* currentTimeMillis;
      const revoked = yield* SynchronizedRef.modify(state, ({ records }) => {
        const credentialIds: Array<string> = [];
        const next = new Map(
          Array.from(records).filter(([, record]) => {
            if (!predicate(record)) return true;
            credentialIds.push(record.scope.credentialId);
            return false;
          }),
        );
        return [credentialIds, { records: next }] as const;
      });
      if (revoked.length > 0) {
        yield* audit({ type: "revoked", credentialIds: revoked, reason, occurredAt: now });
      }
    });

  return McpSessionRegistry.of({
    audience,
    issue,
    rotate,
    resolve,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere(
          (record) => record.scope.providerSessionId === providerSessionId,
          "provider_session",
        );
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId, "thread");
    }),
    revokeAll: revokeWhere(() => true, "all"),
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
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.rotate(request)
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
