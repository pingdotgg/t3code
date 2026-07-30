import {
  VOICE_BUD_PROTOCOL_VERSION,
  VoiceBudExternalRequest,
  VoiceBudRequestId,
  type VoiceBudExternalResponse,
  type VoiceBudRecordingId,
  type VoiceBudResponseCode,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const VOICE_BUD_MAX_FRAME_BYTES = 64 * 1024;
export const VOICE_BUD_CLOCK_SKEW_MS = 15_000;

const decodeExternalRequest = Schema.decodeUnknownSync(VoiceBudExternalRequest);

export interface VoiceBudBridgeRequestHandler {
  readonly begin: (
    requestId: VoiceBudRequestId,
    recordingId: VoiceBudRecordingId,
  ) => Promise<VoiceBudResponseCode>;
  readonly complete: (
    deliveryId: VoiceBudRequestId,
    recordingId: VoiceBudRecordingId,
    transcript: string,
  ) => Promise<VoiceBudResponseCode>;
  readonly close: () => Promise<void>;
}

export interface VoiceBudBridgeServerOptions {
  readonly directory: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly handler: VoiceBudBridgeRequestHandler;
  readonly path: Path.Path;
  readonly now?: () => number;
  readonly readTimeoutMs?: number;
  readonly rateLimit?: number;
  readonly rateWindowMs?: number;
  readonly secret?: string;
  readonly socketName?: string;
}

export const VoiceBudBridgeDescriptor = Schema.Struct({
  version: Schema.Literal(VOICE_BUD_PROTOCOL_VERSION),
  transport: Schema.Literal("unix"),
  socketPath: Schema.String,
  secret: Schema.String,
  pid: Schema.Int,
});
export type VoiceBudBridgeDescriptor = typeof VoiceBudBridgeDescriptor.Type;

const encodeDescriptor = Schema.encodeSync(Schema.fromJsonString(VoiceBudBridgeDescriptor));
const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(VoiceBudBridgeDescriptor),
);

function response(
  requestId: VoiceBudRequestId | null,
  code: VoiceBudResponseCode,
): VoiceBudExternalResponse {
  return {
    version: VOICE_BUD_PROTOCOL_VERSION,
    requestId,
    accepted: code === "accepted",
    code,
  };
}

function safeRequestId(value: unknown): VoiceBudRequestId | null {
  if (!value || typeof value !== "object") return null;
  const requestId = (value as { requestId?: unknown }).requestId;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId)
  ) {
    return null;
  }
  return VoiceBudRequestId.make(requestId);
}

function secretMatches(actual: string, supplied: string): boolean {
  const actualBytes = Buffer.from(actual);
  const suppliedBytes = Buffer.from(supplied);
  return (
    actualBytes.length === suppliedBytes.length &&
    NodeCrypto.timingSafeEqual(actualBytes, suppliedBytes)
  );
}

const textEncoder = new TextEncoder();

export class VoiceBudBridgeServerOperationError extends Schema.TaggedErrorClass<VoiceBudBridgeServerOperationError>()(
  "VoiceBudBridgeServerOperationError",
  {
    operation: Schema.Literals(["validate-directory", "listen"]),
    cause: Schema.Defect(),
  },
) {}

function closeServer(server: NodeNet.Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    try {
      server.close(() => resume(Effect.void));
    } catch {
      resume(Effect.void);
    }
  });
}

export class VoiceBudBridgeServer {
  readonly #options: VoiceBudBridgeServerOptions;
  readonly #now: () => number;
  readonly #secret: string;
  readonly #seenRequestIds = new Map<string, number>();
  readonly #seenNonces = new Map<string, number>();
  readonly #requestTimes: number[] = [];
  #server: NodeNet.Server | null = null;
  #descriptor: VoiceBudBridgeDescriptor | null = null;

  constructor(options: VoiceBudBridgeServerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#secret = options.secret ?? NodeCrypto.randomBytes(32).toString("base64url");
  }

  get descriptor(): VoiceBudBridgeDescriptor | null {
    return this.#descriptor;
  }

  #withinRateLimit(): boolean {
    const now = this.#now();
    const windowMs = this.#options.rateWindowMs ?? 60_000;
    const limit = this.#options.rateLimit ?? 60;
    while (this.#requestTimes.length > 0 && this.#requestTimes[0]! <= now - windowMs) {
      this.#requestTimes.shift();
    }
    if (this.#requestTimes.length >= limit) {
      return false;
    }
    this.#requestTimes.push(now);
    return true;
  }

  #pruneReplayCache(): void {
    // A request may arrive with a timestamp at the positive skew boundary, so
    // retain replay keys for the full interval in which that frame stays valid.
    const cutoff = this.#now() - VOICE_BUD_CLOCK_SKEW_MS * 2;
    for (const [key, seenAt] of this.#seenRequestIds) {
      if (seenAt < cutoff) this.#seenRequestIds.delete(key);
    }
    for (const [key, seenAt] of this.#seenNonces) {
      if (seenAt < cutoff) this.#seenNonces.delete(key);
    }
  }

  async #handlePayload(raw: string): Promise<VoiceBudExternalResponse> {
    if (!this.#withinRateLimit()) {
      return response(null, "rate_limited");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return response(null, "malformed");
    }
    const requestId = safeRequestId(parsed);

    let request: VoiceBudExternalRequest;
    try {
      request = decodeExternalRequest(parsed);
    } catch {
      return response(requestId, "malformed");
    }

    if (!secretMatches(this.#secret, request.auth)) {
      return response(request.requestId, "authentication_failed");
    }
    if (Math.abs(this.#now() - request.sentAt) > VOICE_BUD_CLOCK_SKEW_MS) {
      return response(request.requestId, "expired");
    }

    this.#pruneReplayCache();
    if (this.#seenRequestIds.has(request.requestId) || this.#seenNonces.has(request.nonce)) {
      return response(request.requestId, "replay");
    }
    const now = this.#now();
    this.#seenRequestIds.set(request.requestId, now);
    this.#seenNonces.set(request.nonce, now);

    const code =
      request.type === "recording.started"
        ? await this.#options.handler.begin(request.requestId, request.recordingId)
        : await this.#options.handler.complete(
            request.requestId,
            request.recordingId,
            request.transcript,
          );
    return response(request.requestId, code);
  }

  #handleSocket(socket: NodeNet.Socket): void {
    socket.setTimeout(this.#options.readTimeoutMs ?? 2_000);
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];

    const finish = (result: VoiceBudExternalResponse) => {
      if (settled) return;
      settled = true;
      socket.end(`${JSON.stringify(result)}\n`);
    };

    socket.on("timeout", () => finish(response(null, "malformed")));
    socket.on("error", () => {
      settled = true;
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > VOICE_BUD_MAX_FRAME_BYTES) {
        finish(response(null, "oversized"));
        return;
      }
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks, bytes);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      socket.setTimeout(0);
      const frame = buffer.subarray(0, newline).toString("utf8");
      if (
        buffer
          .subarray(newline + 1)
          .toString("utf8")
          .trim().length > 0
      ) {
        finish(response(null, "malformed"));
        return;
      }
      socket.pause();
      void this.#handlePayload(frame).then(finish, () => finish(response(null, "malformed")));
    });
  }

  readonly start = Effect.fn("VoiceBudBridgeServer.start")(function* (this: VoiceBudBridgeServer) {
    if (this.#server) {
      if (!this.#descriptor) throw new Error("VoiceBud bridge descriptor is unavailable.");
      return this.#descriptor;
    }
    const fileSystem = this.#options.fileSystem;
    const path = this.#options.path;
    const directory = this.#options.directory;
    yield* fileSystem.makeDirectory(directory, {
      recursive: true,
      mode: 0o700,
    });
    const resolvedDirectory = path.resolve(directory);
    const canonicalDirectory = yield* fileSystem.realPath(directory);
    const canonicalParent = yield* fileSystem.realPath(path.dirname(resolvedDirectory));
    const expectedDirectory = path.join(canonicalParent, path.basename(resolvedDirectory));
    if (canonicalDirectory !== expectedDirectory) {
      return yield* new VoiceBudBridgeServerOperationError({
        operation: "validate-directory",
        cause: new Error("VoiceBud bridge directory must not be a symbolic link."),
      });
    }
    const stats = yield* fileSystem.stat(canonicalDirectory);
    if (stats.type !== "Directory") {
      return yield* new VoiceBudBridgeServerOperationError({
        operation: "validate-directory",
        cause: new Error("VoiceBud bridge directory is not a private directory."),
      });
    }
    yield* fileSystem.chmod(canonicalDirectory, 0o700);
    const socketName =
      this.#options.socketName ??
      `bridge-${process.pid}-${NodeCrypto.randomBytes(8).toString("hex")}.sock`;
    const socketPath = path.join(this.#options.directory, socketName);
    const descriptorPath = path.join(this.#options.directory, "bridge.json");
    const server = NodeNet.createServer((socket) => this.#handleSocket(socket));
    server.maxConnections = 64;
    yield* Effect.callback<void, VoiceBudBridgeServerOperationError>((resume) => {
      const onError = (cause: Error) => {
        server.off("listening", onListening);
        resume(
          Effect.fail(
            new VoiceBudBridgeServerOperationError({
              operation: "listen",
              cause,
            }),
          ),
        );
      };
      const onListening = () => {
        server.off("error", onError);
        resume(Effect.void);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
      return Effect.sync(() => {
        server.off("error", onError);
        server.off("listening", onListening);
      });
    }).pipe(
      Effect.onError(() => fileSystem.remove(socketPath, { force: true }).pipe(Effect.ignore)),
    );
    const descriptor: VoiceBudBridgeDescriptor = {
      version: VOICE_BUD_PROTOCOL_VERSION,
      transport: "unix",
      socketPath,
      secret: this.#secret,
      pid: process.pid,
    };
    yield* Effect.gen(function* () {
      yield* fileSystem.chmod(socketPath, 0o600);
      const tempPath = `${descriptorPath}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(textEncoder.encode(`${encodeDescriptor(descriptor)}\n`));
          yield* file.sync;
        }),
      ).pipe(
        Effect.andThen(fileSystem.chmod(tempPath, 0o600)),
        Effect.andThen(fileSystem.rename(tempPath, descriptorPath)),
        Effect.andThen(fileSystem.chmod(descriptorPath, 0o600)),
        Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.onError(() =>
        Effect.all([
          closeServer(server),
          fileSystem.remove(socketPath, { force: true }).pipe(Effect.ignore),
        ]).pipe(Effect.asVoid),
      ),
    );
    this.#server = server;
    this.#descriptor = descriptor;
    return descriptor;
  });

  readonly stop = Effect.fn("VoiceBudBridgeServer.stop")(function* (this: VoiceBudBridgeServer) {
    const server = this.#server;
    const descriptor = this.#descriptor;
    this.#server = null;
    this.#descriptor = null;
    yield* Effect.promise(() => this.#options.handler.close());
    if (server) {
      yield* closeServer(server);
    }
    if (descriptor) {
      const fileSystem = this.#options.fileSystem;
      yield* fileSystem.remove(descriptor.socketPath, { force: true });
      const descriptorPath = this.#options.path.join(this.#options.directory, "bridge.json");
      const current = yield* fileSystem
        .readFileString(descriptorPath)
        .pipe(Effect.map(decodeDescriptor), Effect.option, Effect.map(Option.flatten));
      if (Option.isSome(current) && current.value.secret === descriptor.secret) {
        yield* fileSystem.remove(descriptorPath, { force: true });
      }
    }
  });
}
