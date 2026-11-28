// @effect-diagnostics nodeBuiltinImport:off - Private signed IPC answering the OpenAI browser plugin's access check.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import { acquirePrivateIpcEndpoint } from "./privateIpcEndpoint.ts";

// The plugin sends one request of about 250 bytes per turn and needs one reply.
const MAX_REQUEST_BYTES = 1024;
const MAX_CONNECTIONS = 32;
const CONNECTION_TIMEOUT = "5 seconds";

const AccessRequest = Schema.Struct({
  executorId: Schema.String.check(Schema.isMaxLength(128)),
  sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  turnId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.Int,
      method: Schema.Literal("browser/access"),
      params: AccessRequest,
    }),
  ),
  { onExcessProperty: "error" },
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class BrowserAccessHostError extends Schema.TaggedError<BrowserAccessHostError>()(
  "BrowserAccessHostError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The private browser access host failed.";
  }
}

// The plugin's native pipe frames are a native-endian uint32 length, then UTF-8 JSON.
const readLength = (bytes: Buffer) =>
  NodeOS.endianness() === "LE" ? bytes.readUInt32LE() : bytes.readUInt32BE();

const readFrame = (socket: NodeNet.Socket) =>
  Effect.callback<string, BrowserAccessHostError>((resume) => {
    let bytes = Buffer.alloc(0);
    const fail = () => resume(Effect.fail(new BrowserAccessHostError({ cause: "Invalid frame" })));
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const size = readLength(bytes);
      if (size > MAX_REQUEST_BYTES || bytes.length > size + 4) return fail();
      if (bytes.length === size + 4) resume(Effect.succeed(bytes.subarray(4).toString("utf8")));
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("end", fail);
    socket.once("close", fail);
    return Effect.sync(() => {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("end", fail);
      socket.off("close", fail);
    });
  });

const writeFrame = (socket: NodeNet.Socket, json: string) =>
  Effect.callback<void, BrowserAccessHostError>((resume) => {
    const payload = Buffer.from(json);
    const header = Buffer.alloc(4);
    if (NodeOS.endianness() === "LE") header.writeUInt32LE(payload.length);
    else header.writeUInt32BE(payload.length);
    const fail = () => resume(Effect.fail(new BrowserAccessHostError({ cause: "Peer closed" })));
    socket.once("error", fail);
    socket.once("close", fail);
    socket.end(Buffer.concat([header, payload]), () => resume(Effect.void));
    return Effect.sync(() => {
      socket.off("error", fail);
      socket.off("close", fail);
    });
  });

/**
 * Serves `browser/access` for one Codex process until the scope closes. Codex forwards the
 * returned variables to the browser plugin, which verifies each signed decision.
 */
export const makeCodexBrowserAccessHost = Effect.fn("CodexBrowserAccessHost.make")(function* (
  isAllowed: (request: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Effect.Effect<boolean>,
) {
  const platform = yield* HostProcess.Platform;
  const endpoint = yield* acquirePrivateIpcEndpoint("t3-browser").pipe(
    Effect.mapError((cause) => new BrowserAccessHostError({ cause })),
  );
  const { publicKey, privateKey } = yield* Effect.try({
    try: () => NodeCrypto.generateKeyPairSync("ed25519"),
    catch: (cause) => new BrowserAccessHostError({ cause }),
  });
  const executorId = NodeCrypto.randomUUID();
  const connections = yield* FiberSet.make<void>();
  const run = yield* FiberSet.runtime(connections)();
  const sockets = new Set<NodeNet.Socket>();
  let closing = false;
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    if (closing || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    run(
      Effect.gen(function* () {
        // Windows pipes admit read-only peers; reply only to a complete, valid request.
        const { id, params } = yield* readFrame(socket).pipe(Effect.flatMap(decodeRequest));
        const allowed = params.executorId === executorId && (yield* isAllowed(params));
        const payload = encodeJson({ domain: "codex.browserAccess.v1", request: params, allowed });
        const signature = NodeCrypto.sign(null, Buffer.from(payload), privateKey);
        yield* writeFrame(
          socket,
          encodeJson({
            jsonrpc: "2.0",
            id,
            result: { payload, signature: signature.toString("base64") },
          }),
        );
      }).pipe(
        Effect.timeout(CONNECTION_TIMEOUT),
        Effect.ignoreCause,
        Effect.ensuring(Effect.sync(() => socket.destroy())),
      ),
    );
  });
  server.on("error", () => {});
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      for (const socket of sockets) socket.destroy();
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
    }),
  );
  yield* Effect.callback<void, BrowserAccessHostError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new BrowserAccessHostError({ cause })));
    server.once("error", onError);
    server.listen(endpoint, () => resume(Effect.void));
    return Effect.sync(() => server.off("error", onError));
  });
  if (platform !== "win32") {
    yield* Effect.tryPromise({
      try: () => NodeFSP.chmod(endpoint, 0o600),
      catch: (cause) => new BrowserAccessHostError({ cause }),
    });
  }
  return {
    BROWSER_USE_ACCESS_EXECUTOR_ID: executorId,
    BROWSER_USE_ACCESS_PIPE_PATH: endpoint,
    BROWSER_USE_ACCESS_VERIFYING_IDENTITY: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
});
