import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { T3_REMOTE_HELPER_PROTOCOL_VERSION, type RemoteHostId } from "@t3tools/contracts";
import { buildSshArgs } from "@t3tools/shared/ssh";
import { Effect, Layer } from "effect";

import { createLogger } from "../../logger";
import {
  REMOTE_HELPER_NOTIFICATION_METHODS,
  REMOTE_HELPER_METHODS,
  type RemoteHelperFailure,
  type RemoteHelperMethodParams,
  type RemoteHelperMethodResults,
  type RemoteHelperNotification,
  type RemoteHelperRequest,
  type RemoteHelperSuccess,
  type RemoteHostBoundNotification,
} from "../protocol.ts";
import { RemoteHostRegistry } from "../Services/HostRegistry.ts";
import {
  RemoteHelperClient,
  RemoteHelperError,
  type RemoteHelperClientShape,
} from "../Services/HelperClient.ts";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface RemoteConnection {
  readonly remoteHostId: RemoteHostId;
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: readline.Interface;
  readonly pending: Map<string, PendingRequest>;
  readonly heartbeat: NodeJS.Timeout;
}

function toRemoteHelperError(
  message: string,
  remoteHostId?: RemoteHostId,
  cause?: unknown,
): RemoteHelperError {
  return new RemoteHelperError({
    message,
    ...(remoteHostId ? { remoteHostId } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const CALL_TIMEOUT_MS = 20_000;

const makeRemoteHelperClient = Effect.gen(function* () {
  const logger = createLogger("remote-helper");
  const registry = yield* RemoteHostRegistry;
  const connections = new Map<RemoteHostId, RemoteConnection>();
  const connectionPromises = new Map<RemoteHostId, Promise<RemoteConnection>>();
  const listeners = new Set<(notification: RemoteHostBoundNotification) => void>();

  const removeConnection = (remoteHostId: RemoteHostId, error?: Error) => {
    const existing = connections.get(remoteHostId);
    if (!existing) {
      connectionPromises.delete(remoteHostId);
      return;
    }
    clearInterval(existing.heartbeat);
    existing.output.close();
    connections.delete(remoteHostId);
    connectionPromises.delete(remoteHostId);
    for (const pending of existing.pending.values()) {
      pending.reject(
        error ?? new Error(`Remote helper connection closed for host '${remoteHostId}'.`),
      );
    }
    existing.pending.clear();
  };

  const writeRequest = <TMethod extends keyof RemoteHelperMethodParams & string>(
    connection: RemoteConnection,
    method: TMethod,
    params: RemoteHelperMethodParams[TMethod],
  ): Promise<RemoteHelperMethodResults[TMethod]> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const payload: RemoteHelperRequest<RemoteHelperMethodParams[TMethod]> = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      const timeout = setTimeout(() => {
        connection.pending.delete(id);
        reject(new Error(`Remote helper request timed out: ${method}`));
      }, CALL_TIMEOUT_MS);

      connection.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as RemoteHelperMethodResults[TMethod]);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      connection.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        connection.pending.delete(id);
        reject(error);
      });
    });

  const ensureConnection = (remoteHostId: RemoteHostId): Promise<RemoteConnection> => {
    const existing = connections.get(remoteHostId);
    if (existing) {
      return Promise.resolve(existing);
    }
    const inFlight = connectionPromises.get(remoteHostId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const hostOption = await Effect.runPromise(registry.getById(remoteHostId));
      const host = hostOption._tag === "Some" ? hostOption.value : null;
      if (!host) {
        throw new Error(`Remote host '${remoteHostId}' was not found.`);
      }

      const child = spawn("ssh", buildSshArgs(host, host.helperCommand), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output = readline.createInterface({ input: child.stdout });
      const pending = new Map<string, PendingRequest>();
      const heartbeat = setInterval(() => {
        const active = connections.get(remoteHostId);
        if (!active) {
          return;
        }
        void writeRequest(active, REMOTE_HELPER_METHODS.hostPing, undefined).catch((error) => {
          logger.warn("remote helper heartbeat failed", { remoteHostId, error });
          removeConnection(remoteHostId, error instanceof Error ? error : undefined);
        });
      }, HEARTBEAT_INTERVAL_MS);

      const connection: RemoteConnection = {
        remoteHostId,
        child,
        output,
        pending,
        heartbeat,
      };

      child.stderr.on("data", (chunk) => {
        const message = Buffer.from(chunk).toString("utf8").trim();
        if (message.length > 0) {
          logger.warn("remote helper stderr", { remoteHostId, message });
        }
      });

      child.once("error", (error) => {
        removeConnection(remoteHostId, error);
      });
      child.once("close", (_code, _signal) => {
        removeConnection(remoteHostId, new Error(`Remote helper connection closed for ${remoteHostId}.`));
      });

      output.on("line", (line) => {
        if (line.trim().length === 0) {
          return;
        }
        let parsed:
          | RemoteHelperSuccess
          | RemoteHelperFailure
          | RemoteHelperNotification<unknown>;
        try {
          parsed = JSON.parse(line) as
            | RemoteHelperSuccess
            | RemoteHelperFailure
            | RemoteHelperNotification<unknown>;
        } catch (error) {
          logger.warn("failed to parse remote helper line", { remoteHostId, line, error });
          return;
        }

        if ("id" in parsed) {
          const pendingRequest = pending.get(parsed.id);
          if (!pendingRequest) {
            return;
          }
          pending.delete(parsed.id);
          if ("error" in parsed) {
            pendingRequest.reject(new Error(parsed.error.message));
            return;
          }
          pendingRequest.resolve(parsed.result);
          return;
        }

        if (parsed.method === REMOTE_HELPER_NOTIFICATION_METHODS.providerEvent) {
          const notification: RemoteHostBoundNotification = {
            remoteHostId,
            method: REMOTE_HELPER_NOTIFICATION_METHODS.providerEvent,
            params: parsed.params as RemoteHostBoundNotification["params"],
          };
          for (const listener of listeners) {
            listener(notification);
          }
          return;
        }

        if (parsed.method === REMOTE_HELPER_NOTIFICATION_METHODS.terminalEvent) {
          const notification: RemoteHostBoundNotification = {
            remoteHostId,
            method: REMOTE_HELPER_NOTIFICATION_METHODS.terminalEvent,
            params: parsed.params as RemoteHostBoundNotification["params"],
          };
          for (const listener of listeners) {
            listener(notification);
          }
        }
      });

      connections.set(remoteHostId, connection);
      const capabilities = await writeRequest(connection, REMOTE_HELPER_METHODS.hostGetCapabilities, undefined);
      if (capabilities.protocolVersion !== T3_REMOTE_HELPER_PROTOCOL_VERSION) {
        throw new Error(
          `Remote helper protocol mismatch. Expected ${T3_REMOTE_HELPER_PROTOCOL_VERSION}, received ${capabilities.protocolVersion}.`,
        );
      }
      await Effect.runPromise(
        registry.updateConnectionState({
          remoteHostId,
          helperVersion: capabilities.helperVersion,
          checkedAt: new Date().toISOString(),
          ok: true,
          message: null,
        }),
      );
      return connection;
    })().catch(async (error) => {
      const checkedAt = new Date().toISOString();
      await Effect.runPromise(
        registry.updateConnectionState({
          remoteHostId,
          checkedAt,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.catch(() => Effect.void)),
      );
      removeConnection(remoteHostId, error instanceof Error ? error : undefined);
      throw error;
    });

    connectionPromises.set(remoteHostId, promise);
    return promise;
  };

  const call = <TMethod extends keyof RemoteHelperMethodParams & string>(
    remoteHostId: RemoteHostId,
    method: TMethod,
    params: RemoteHelperMethodParams[TMethod],
  ) =>
    Effect.tryPromise({
      try: async () => {
        const connection = await ensureConnection(remoteHostId);
        return writeRequest(connection, method, params);
      },
      catch: (cause) =>
        toRemoteHelperError(
          cause instanceof Error ? cause.message : "Remote helper request failed.",
          remoteHostId,
          cause,
        ),
    });

  const testConnection = (remoteHostId: RemoteHostId) =>
    call(remoteHostId, REMOTE_HELPER_METHODS.hostGetCapabilities, undefined);

  const subscribe: RemoteHelperClientShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  return {
    call,
    testConnection,
    subscribe,
  } satisfies RemoteHelperClientShape;
});

export const RemoteHelperClientLive = Layer.effect(RemoteHelperClient, makeRemoteHelperClient);
