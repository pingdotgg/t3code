import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import type { McpInvocationScope } from "../Services/McpInvocationContext.ts";
import {
  McpSessionRegistry,
  type McpCredentialRequest,
  type McpIssuedCredential,
  type McpSessionRegistryShape,
} from "../Services/McpSessionRegistry.ts";

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationScope;
  readonly lastUsedAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAXIMUM_LIFETIME_MS = 8 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export const makeMcpSessionRegistry = (options: McpSessionRegistryOptions = {}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const environment = yield* ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const httpServer = yield* HttpServer.HttpServer;
    const state = yield* Ref.make<RegistryState>({ records: new Map() });
    const now = options.now ?? Date.now;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
    const endpoint =
      httpServer.address._tag === "TcpAddress"
        ? `http://127.0.0.1:${httpServer.address.port}/mcp`
        : "http://127.0.0.1/mcp";

    const hashToken = (token: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(token))
        .pipe(Effect.map(bytesToHex), Effect.orDie);

    const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
      let changed = false;
      const next = new Map<string, CredentialRecord>();
      for (const [hash, record] of records) {
        if (timestamp <= record.scope.expiresAt && timestamp - record.lastUsedAt <= idleTimeoutMs) {
          next.set(hash, record);
        } else {
          changed = true;
        }
      }
      return changed ? next : records;
    };

    const issue: McpSessionRegistryShape["issue"] = (request) =>
      Effect.gen(function* () {
        const issuedAt = now();
        const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const rawToken = yield* crypto
          .randomBytes(32)
          .pipe(Effect.map(tokenFromBytes), Effect.orDie);
        const tokenHash = yield* hashToken(rawToken);
        const expiresAt = issuedAt + maximumLifetimeMs;
        const scope: McpInvocationScope = {
          environmentId,
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          capabilities: new Set(["preview"]),
          issuedAt,
          expiresAt,
        };
        yield* Ref.update(state, ({ records }) => {
          const next = new Map(pruneExpired(records, issuedAt));
          next.set(tokenHash, { tokenHash, scope, lastUsedAt: issuedAt });
          return { records: next };
        });
        return {
          config: {
            environmentId,
            threadId: scope.threadId,
            providerSessionId,
            providerInstanceId: scope.providerInstanceId,
            endpoint,
            authorizationHeader: `Bearer ${rawToken}`,
          },
          expiresAt,
        };
      });

    const resolve: McpSessionRegistryShape["resolve"] = (rawToken) =>
      Effect.gen(function* () {
        if (rawToken.length === 0) return undefined;
        const tokenHash = yield* hashToken(rawToken);
        const timestamp = now();
        let resolved: McpInvocationScope | undefined;
        yield* Ref.update(state, ({ records }) => {
          const current = pruneExpired(records, timestamp);
          const record = current.get(tokenHash);
          if (!record) return { records: current };
          resolved = record.scope;
          const next = new Map(current);
          next.set(tokenHash, { ...record, lastUsedAt: timestamp });
          return { records: next };
        });
        return resolved;
      });

    const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
      Ref.update(state, ({ records }) => ({
        records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
      }));

    return McpSessionRegistry.of({
      issue,
      resolve,
      revokeProviderSession: (providerSessionId) =>
        revokeWhere((record) => record.scope.providerSessionId === providerSessionId),
      revokeThread: (threadId) => revokeWhere((record) => record.scope.threadId === threadId),
      revokeAll: Ref.set(state, { records: new Map() }),
    });
  });

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

export const McpSessionRegistryLive: Layer.Layer<
  McpSessionRegistry,
  never,
  Crypto.Crypto | ServerEnvironment | HttpServer.HttpServer
> = Layer.effect(
  McpSessionRegistry,
  makeMcpSessionRegistry().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;
