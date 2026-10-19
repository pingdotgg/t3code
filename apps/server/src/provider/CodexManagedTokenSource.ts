// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native socket callbacks own absolute handshake deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { codexChatGptProfileKey, type CodexChatGptCredentials } from "./CodexChatGptAuth.ts";

const REQUEST = Buffer.from("token\n");
const REQUEST_BYTES = 64;
const RESPONSE_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const UNIX_SOCKET_PATH_BYTES = 100;

interface OwnedEndpoint {
  readonly endpoint: string;
  readonly directory?: string;
}

const privateEndpoint = async (
  platform: NodeJS.Platform,
  uid: number | undefined,
): Promise<OwnedEndpoint> => {
  if (platform === "win32") {
    // Keep Node/libuv's default named-pipe DACL; do not broaden it with
    // readableAll/writableAll. The random name is routing, not a same-user capability.
    return {
      endpoint: `\\\\.\\pipe\\t3-code-managed-codex-${NodeCrypto.randomUUID()}`,
    };
  }

  if (uid === undefined) throw new Error("Missing local user identity");

  const candidates = [NodeOS.tmpdir(), "/tmp"];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parent = await NodeFSP.realpath(candidate);
      const stat = await NodeFSP.lstat(parent);
      const trusted =
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        ((stat.uid === uid && (stat.mode & 0o022) === 0) ||
          (stat.uid === 0 && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0)));
      if (!trusted) throw new Error("Untrusted IPC parent");

      const directory = await NodeFSP.mkdtemp(NodePath.join(parent, "t3-code-token-"));
      try {
        await NodeFSP.chmod(directory, 0o700);
        const created = await NodeFSP.lstat(directory);
        if (
          !created.isDirectory() ||
          created.isSymbolicLink() ||
          created.uid !== uid ||
          (created.mode & 0o777) !== 0o700
        ) {
          throw new Error("Unprotected IPC directory");
        }
        const endpoint = NodePath.join(directory, "s");
        if (Buffer.byteLength(endpoint) > UNIX_SOCKET_PATH_BYTES)
          throw new Error("IPC path is too long");
        return { endpoint, directory };
      } catch (cause) {
        await NodeFSP.rmdir(directory).catch(() => undefined);
        throw cause;
      }
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError ?? new Error("Could not allocate private IPC endpoint");
};

export const makeCodexManagedTokenSource = Effect.fn("makeCodexManagedTokenSource")(function* (
  instanceId: ProviderInstanceId,
  launchCredentials: CodexChatGptCredentials,
  access: Effect.Effect<CodexChatGptCredentials, ProviderSetupError>,
) {
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const launchProfileKey = codexChatGptProfileKey(launchCredentials);
  const inFlight = new Set<Promise<void>>();
  const sockets = new Set<NodeNet.Socket>();
  let credentialRead: Promise<CodexChatGptCredentials> | undefined;
  let closing = false;

  // Concurrent helpers must share one credential read so a failing refresh cannot
  // queue repeated serialized OAuth attempts behind the auth/session locks.
  const readCredentials = () => {
    if (credentialRead !== undefined) return credentialRead;
    const pending = runPromise(access);
    credentialRead = pending;
    const clear = () => {
      if (credentialRead === pending) credentialRead = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  };

  const owned = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => privateEndpoint(platform, uid),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId,
          operation: "runtime",
          detail: "Could not prepare the private managed Codex credential channel.",
          cause,
        }),
    }),
    ({ endpoint, directory }) =>
      Effect.promise(async () => {
        if (platform !== "win32") await NodeFSP.unlink(endpoint).catch(() => undefined);
        if (directory) await NodeFSP.rmdir(directory).catch(() => undefined);
      }),
  );

  // Acquire the listener after its endpoint owner. Scope finalizers run LIFO,
  // so shutdown closes/drains the server before unlinking/removing the endpoint.
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<NodeNet.Server>((resolve, reject) => {
          const server = NodeNet.createServer((socket) => {
            if (closing || sockets.size >= 32) {
              socket.destroy();
              return;
            }
            sockets.add(socket);
            const handshakeTimer = NodeTimers.setTimeout(
              () => socket.destroy(),
              HANDSHAKE_TIMEOUT_MS,
            );
            handshakeTimer.unref();
            socket.once("close", () => {
              NodeTimers.clearTimeout(handshakeTimer);
              sockets.delete(socket);
            });
            socket.once("error", () => {});

            let request = Buffer.alloc(0);
            const onData = (chunk: Buffer) => {
              if (request.length + chunk.length > REQUEST_BYTES) {
                socket.destroy();
                return;
              }
              request = Buffer.concat([request, chunk]);
              const newline = request.indexOf(10);
              if (newline < 0) return;
              socket.off("data", onData);
              if (closing || newline !== request.length - 1 || !request.equals(REQUEST)) {
                socket.destroy();
                return;
              }

              NodeTimers.clearTimeout(handshakeTimer);
              let finish!: () => void;
              const tracked = new Promise<void>((resolve) => {
                finish = resolve;
              });
              inFlight.add(tracked);
              void readCredentials()
                .then((credentials) => {
                  if (
                    socket.destroyed ||
                    codexChatGptProfileKey(credentials) !== launchProfileKey ||
                    Buffer.byteLength(credentials.accessToken) > RESPONSE_BYTES
                  ) {
                    socket.destroy();
                    return;
                  }
                  socket.end(credentials.accessToken);
                })
                .catch(() => socket.destroy())
                .finally(() => {
                  inFlight.delete(tracked);
                  finish();
                });
            };
            socket.on("data", onData);
          });
          server.maxConnections = 32;
          const onStartupError = (cause: Error) => reject(cause);
          server.once("error", onStartupError);
          server.listen(owned.endpoint, () => {
            server.off("error", onStartupError);
            // A post-start listener error must fail this credential channel,
            // not crash the whole T3 server process or admit more credential work.
            server.on("error", () => {
              closing = true;
              for (const socket of sockets) socket.destroy();
              if (server.listening) server.close();
            });
            resolve(server);
          });
        }),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId,
          operation: "runtime",
          detail: "Could not start the private managed Codex credential channel.",
          cause,
        }),
    }),
    (server) =>
      Effect.promise(async () => {
        // This is the admission cutoff: callbacks that run after this point
        // must not start a fresh credential read.
        closing = true;
        for (const socket of sockets) socket.destroy();
        const closed = new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
        await Promise.allSettled(inFlight);
        await closed;
      }),
  );
  if (platform !== "win32")
    yield* Effect.tryPromise({
      try: () => NodeFSP.chmod(owned.endpoint, 0o600),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId,
          operation: "runtime",
          detail: "Could not secure the private managed Codex credential channel.",
          cause,
        }),
    });

  const address = server.address();
  if (address === null)
    return yield* new ProviderSetupError({
      instanceId,
      operation: "runtime",
      detail: "Could not resolve the private managed Codex credential channel.",
    });

  return {
    endpoint: owned.endpoint,
    profileKey: launchProfileKey,
  };
});
