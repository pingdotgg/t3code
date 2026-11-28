// @effect-diagnostics nodeBuiltinImport:off - Server-owned private pipe/Unix socket, never a public listener.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { EnvironmentId, ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import * as Protocol from "./CodexManagedTokenProtocol.ts";

const MAX_CONNECTIONS = 32;
const MAX_JOBS = 16;
const MAX_REFUSALS = 64;
// Codex asks once before its first request, then retries the unauthenticated
// request for a while before it reports the 401.
const RECENT_REFUSAL_MS = 10 * 60_000;
// Reserve the socket-frame budget so the helper hears a timeout refusal before its
// own deadline while keeping the lock (40s), OAuth (20s) and store headroom intact.
const ANSWER_TIMEOUT_MS = Protocol.COMMAND_TIMEOUT_MS - Protocol.SOCKET_IDLE_MS;
const TIMED_OUT: Protocol.Refusal = {
  kind: "timeout",
  message: "Timed out waiting for the managed ChatGPT connection. Try again.",
};
// Stay below macOS's 104-byte and Linux's 108-byte sockaddr_un limits, including NUL.
const UNIX_SOCKET_PATH_BYTES = 100;
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(Protocol.Response));
class BrokerStartError extends Schema.TaggedError<BrokerStartError>()(
  "ManagedTokenBrokerStartError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not start the private managed token listener.";
  }
}
export class CodexManagedTokenBroker extends Context.Service<
  CodexManagedTokenBroker,
  {
    readonly endpoint: Effect.Effect<string, BrokerStartError>;
    readonly awaitIdle: Effect.Effect<void>;
    /** A Codex session's latest refused token request, unless it has had a token since. */
    readonly recentRefusal: (
      instanceId: ProviderInstanceId,
      profileKey: string,
      sessionKey: string,
    ) => Effect.Effect<Protocol.Refusal | undefined>;
  }
>()("t3/provider/CodexManagedTokenBroker") {}

const io = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new BrokerStartError({ cause }) });
const acquireListener = Effect.gen(function* () {
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const owned = yield* Effect.acquireRelease(
    io(async () => {
      if (platform === "win32")
        return { endpoint: `\\\\.\\pipe\\t3-token-${NodeCrypto.randomUUID()}` };
      if (uid === undefined) throw new Error("Missing IPC owner");
      const acquireDirectory = async (candidate: string) => {
        const parent = await NodeFSP.realpath(candidate);
        const stat = await NodeFSP.lstat(parent);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          !(
            (stat.uid === uid && (stat.mode & 0o022) === 0) ||
            (stat.uid === 0 && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0))
          )
        )
          throw new Error("Untrusted IPC parent");
        const directory = await NodeFSP.mkdtemp(NodePath.join(parent, "t3-token-"));
        try {
          await NodeFSP.chmod(directory, 0o700);
          const created = await NodeFSP.lstat(directory);
          if (
            !created.isDirectory() ||
            created.isSymbolicLink() ||
            created.uid !== uid ||
            (created.mode & 0o777) !== 0o700
          )
            throw new Error("Unprotected IPC directory");
          const endpoint = NodePath.join(directory, "s");
          if (Buffer.byteLength(endpoint) > UNIX_SOCKET_PATH_BYTES)
            throw new Error("IPC path too long");
          return { endpoint, directory, created };
        } catch (error) {
          await NodeFSP.rmdir(directory);
          throw error;
        }
      };
      return acquireDirectory(NodeOS.tmpdir()).catch(() => acquireDirectory("/tmp"));
    }),
    (owned) =>
      Effect.promise(async () => {
        if (!("directory" in owned)) return;
        // Never recursively remove a replaced directory or another process's files.
        const current = await NodeFSP.lstat(owned.directory).catch(() => undefined);
        if (
          current &&
          current.dev === owned.created.dev &&
          current.ino === owned.created.ino &&
          !current.isSymbolicLink()
        )
          await NodeFSP.rmdir(owned.directory).catch(() => undefined);
      }),
  );
  const jobs = yield* FiberSet.make<void>();
  const runJob =
    yield* FiberSet.runtime(jobs)<
      Exclude<
        Effect.Services<ReturnType<typeof makeCodexChatGptAuth>>,
        import("effect/Scope").Scope
      >
    >();
  const connections = yield* FiberSet.make<void>();
  const runConnection = yield* FiberSet.runtime(connections)();
  const sockets = new Set<NodeNet.Socket>();
  // Each Codex session keeps its own refusal: another session's token or refusal says
  // nothing about why this one was sent without credentials.
  const refusals = new Map<string, Protocol.Refusal & { readonly at: number }>();
  const refusalKey = (session: {
    readonly instanceId: string;
    readonly profileKey: string;
    readonly sessionKey: string;
  }) => `${session.profileKey}:${session.instanceId}:${session.sessionKey}`;
  let closing = false;
  let admitted = 0;
  const refuse = Effect.fn("CodexManagedTokenBroker.refuse")(function* (
    socket: NodeNet.Socket,
    request: {
      readonly instanceId: ProviderInstanceId;
      readonly profileKey: string;
      readonly sessionKey: string;
    },
    refusal: Protocol.Refusal,
    record = true,
  ) {
    yield* Effect.logWarning("Managed ChatGPT token request refused.", {
      instanceId: request.instanceId,
      kind: refusal.kind,
      message: refusal.message,
    });
    if (record) {
      const key = refusalKey(request);
      refusals.delete(key);
      refusals.set(key, { ...refusal, at: yield* Clock.currentTimeMillis });
      if (refusals.size > MAX_REFUSALS) refusals.delete(refusals.keys().next().value!);
    }
    yield* Protocol.writeFrame(socket, encodeResponse({ refusal }), Protocol.RESPONSE_BYTES).pipe(
      Effect.ignore,
    );
  });
  const recentRefusal = Effect.fn("CodexManagedTokenBroker.recentRefusal")(function* (
    instanceId: ProviderInstanceId,
    profileKey: string,
    sessionKey: string,
  ) {
    const refusal = refusals.get(refusalKey({ instanceId, profileKey, sessionKey }));
    if (refusal === undefined) return undefined;
    if ((yield* Clock.currentTimeMillis) - refusal.at > RECENT_REFUSAL_MS) return undefined;
    return { kind: refusal.kind, message: refusal.message };
  });
  // Keep branded validation here so the helper need not load the contracts graph.
  const decode = Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        ...Protocol.Request.fields,
        instanceId: ProviderInstanceId,
        environmentId: EnvironmentId,
      }),
    ),
    {
      onExcessProperty: "error",
    },
  );
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    if (closing || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let transferred = false;
    runConnection(
      Effect.gen(function* () {
        // Windows pipes permit read-only peers by default; send no bytes until a complete request.
        const request = yield* Protocol.readFrame(
          socket,
          Protocol.REQUEST_BYTES,
          Protocol.SOCKET_IDLE_MS,
        ).pipe(Effect.flatMap(decode));
        // Another environment's request says nothing about this environment's instance.
        if (request.environmentId !== environmentId)
          return yield* refuse(
            socket,
            request,
            {
              kind: "environment",
              message:
                "This Codex session belongs to another T3 Code environment. Start a new session.",
            },
            false,
          );
        if (closing)
          return yield* refuse(socket, request, {
            kind: "closing",
            message: "T3 Code is shutting down. Start a new session after it restarts.",
          });
        if (admitted >= MAX_JOBS)
          return yield* refuse(socket, request, {
            kind: "busy",
            message: "Too many managed ChatGPT token requests are waiting. Try again shortly.",
          });
        admitted++;
        transferred = true;
        runJob(
          Effect.gen(function* () {
            const access = yield* Effect.scoped(
              Effect.gen(function* () {
                const auth = yield* makeCodexChatGptAuth({
                  instanceId: request.instanceId,
                  expectedProfileKey: request.profileKey,
                });
                // Retire abandoned permit waits; access saves a started rotation before honoring interruption.
                return yield* auth.access.pipe(Effect.timeout(Protocol.COMMAND_TIMEOUT_MS));
              }),
            ).pipe(Effect.forkChild);
            const answer = yield* Fiber.await(access).pipe(Effect.timeoutOption(ANSWER_TIMEOUT_MS));
            if (Option.isNone(answer)) {
              // The session got no token, so its refusal stands even if the renewal then succeeds.
              yield* refuse(socket, request, TIMED_OUT);
              yield* Fiber.await(access);
              return;
            }
            const result = answer.value;
            if (Exit.isSuccess(result)) {
              yield* Protocol.writeFrame(
                socket,
                encodeResponse({ token: result.value.accessToken }),
                Protocol.RESPONSE_BYTES,
              );
              refusals.delete(refusalKey(request));
              return;
            }
            if (!Cause.hasInterruptsOnly(result.cause))
              yield* refuse(socket, request, refusalFromCause(result.cause));
          }).pipe(
            Effect.ignoreCause,
            Effect.ensuring(
              Effect.sync(() => {
                admitted--;
                socket.destroy();
              }),
            ),
          ),
        );
      }).pipe(
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => {
            if (!transferred) socket.destroy();
          }),
        ),
      ),
    );
  });
  server.on("error", () => {});
  // Drain accepted rotations before the FiberSet finalizers interrupt their fibers.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      for (const socket of sockets) socket.destroy();
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
      yield* FiberSet.awaitEmpty(connections);
      yield* FiberSet.awaitEmpty(jobs);
    }),
  );
  yield* Effect.callback<void, BrokerStartError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new BrokerStartError({ cause })));
    server.once("error", onError);
    try {
      server.listen(owned.endpoint, () => resume(Effect.void));
    } catch (cause) {
      resume(Effect.fail(new BrokerStartError({ cause })));
    }
    return Effect.sync(() => server.off("error", onError));
  });
  if (platform !== "win32") yield* io(() => NodeFSP.chmod(owned.endpoint, 0o600));
  return { endpoint: owned.endpoint, awaitIdle: FiberSet.awaitEmpty(jobs), recentRefusal };
});
const isSetupError = Schema.is(ProviderSetupError);
const refusalFromCause = (cause: Cause.Cause<unknown>): Protocol.Refusal => {
  const error = Cause.squash(cause);
  // Setup failures carry safe, actionable text; anything else could carry token data.
  if (isSetupError(error) && error.operation.length > 0 && error.detail.length > 0)
    return { kind: error.operation.slice(0, 64), message: error.detail.slice(0, 1024) };
  return {
    kind: "failed",
    message: "Could not access the managed ChatGPT connection. Reconnect in T3 Code.",
  };
};
const make = Effect.gen(function* () {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const acquired = yield* acquireListener.pipe(Scope.provide(scope), Effect.result);
  if (acquired._tag === "Failure") {
    yield* Scope.close(scope, Exit.fail(acquired.failure));
    return CodexManagedTokenBroker.of({
      endpoint: Effect.fail(acquired.failure),
      awaitIdle: Effect.void,
      recentRefusal: Effect.fn("CodexManagedTokenBroker.recentRefusal")(() => Effect.undefined),
    });
  }
  return CodexManagedTokenBroker.of({
    endpoint: Effect.succeed(acquired.success.endpoint),
    awaitIdle: acquired.success.awaitIdle,
    recentRefusal: acquired.success.recentRefusal,
  });
});
export const layer = Layer.effect(CodexManagedTokenBroker, make);
