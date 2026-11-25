/**
 * Media sockets (device streams, preview streams, voice) opened with a proof-key-bound ticket.
 * Each upgrade carries its own DPoP proof over the ticket, and runs inside the secure channel
 * whenever the RPC socket would. Call sites keep the browser WebSocket surface they use.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { mediaSocketContext } from "@t3tools/shared/secureChannelSocket";

import type { PreparedConnection } from "../connection/model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { prepareSecureRpcChannel } from "../rpc/secureChannel.ts";

/** What media call sites use of a browser WebSocket. Binary frames may arrive as `Uint8Array`. */
export type EnvironmentSocket = Pick<
  WebSocket,
  | "readyState"
  | "binaryType"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
  | "onopen"
  | "onmessage"
  | "onclose"
  | "onerror"
>;

export type OpenEnvironmentSocket = (url: string) => EnvironmentSocket;

/** The proof's `htu`: a socket URL names the HTTP request the server sees. */
export const socketProofUrl = (url: URL) =>
  `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}${url.pathname}`;

/**
 * Opens sockets authenticated by `ticket` and the device key, or undefined when the connection
 * has no proof key (cookie and bearer sessions keep plain sockets).
 */
export const makeEnvironmentSocketOpener = Effect.fn(
  "clientRuntime.state.makeEnvironmentSocketOpener",
)(function* (prepared: PreparedConnection, ticket: string) {
  const signer = Option.getOrUndefined(
    yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
  );
  if (signer === undefined || prepared.httpAuthorization?._tag !== "Dpop") return undefined;
  const registrations = Option.getOrUndefined(
    yield* Effect.serviceOption(Persistence.ConnectionRegistrationStore),
  );
  const open: OpenEnvironmentSocket = (url) =>
    new SecureEnvironmentSocket((onSocket) =>
      Effect.gen(function* () {
        const secure = yield* prepareSecureRpcChannel(prepared, { signer, registrations });
        const target = new URL(url);
        const proof = yield* signer.createProof({
          method: "GET",
          url: socketProofUrl(target),
          accessToken: ticket,
          ...(prepared.secureChannelRequested && signer.secureClientSocket
            ? { secureChannel: true }
            : {}),
        });
        const context = mediaSocketContext(prepared.environmentId, target.searchParams);
        target.searchParams.set("dpop", proof);
        const raw = yield* Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.sync(() => onSocket(new WebSocket(target))),
            (socket) => Effect.sync(() => socket.close()),
          ),
          { disableReconnects: true },
        );
        return secure === undefined ? raw : yield* secure.wrap(raw, context);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
            }),
        ),
      ),
    );
  return open;
});

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * One connection, never reopened. Frames go out in `send` order through one writer, which seals
 * each in turn, and are delivered in arrival order after each is opened. Any failure, including
 * a frame that does not open, closes the socket and is never followed by plaintext.
 */
class SecureEnvironmentSocket extends EventTarget implements EnvironmentSocket {
  readyState: EnvironmentSocket["readyState"] = CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  onopen: EnvironmentSocket["onopen"] = null;
  onmessage: EnvironmentSocket["onmessage"] = null;
  onclose: EnvironmentSocket["onclose"] = null;
  onerror: EnvironmentSocket["onerror"] = null;
  private raw: WebSocket | undefined;
  private outbound: Queue.Queue<string | Uint8Array> | undefined;
  private closeRequest: { readonly code?: number; readonly reason?: string } | undefined;

  constructor(
    connect: (
      onSocket: (raw: WebSocket) => WebSocket,
    ) => Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope>,
  ) {
    super();
    const fiber = Effect.runFork(
      Effect.gen({ self: this }, function* () {
        // Like a browser socket, nothing is dispatched before the caller attaches its handlers.
        yield* Effect.yieldNow;
        const socket = yield* connect((raw) => (this.raw = raw));
        const writer = yield* socket.writer;
        const reader = yield* socket.reader;
        const outbound = yield* Queue.unbounded<string | Uint8Array>();
        this.outbound = outbound;
        this.readyState = OPEN;
        this.emit("open", new Event("open"));
        const deliver = (frames: ReadonlyArray<string | Uint8Array>) =>
          Effect.sync(() => {
            for (const data of frames) {
              if (this.readyState === OPEN)
                this.emit("message", new MessageEvent("message", { data }));
            }
          });
        // Whichever side fails first ends the connection.
        return yield* Effect.raceFirst(
          Effect.forever(Effect.flatMap(reader.pull, deliver)),
          Effect.forever(Effect.flatMap(Queue.takeAll(outbound), writer.writeAll)),
        );
      }).pipe(Effect.scoped),
    );
    this.interrupt = () => fiber.interruptUnsafe();
    fiber.addObserver((exit) => {
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      const closed =
        Socket.isSocketError(failure) && failure.reason._tag === "SocketCloseError"
          ? failure.reason
          : undefined;
      const code = closed?.code ?? this.closeRequest?.code ?? 1006;
      this.readyState = CLOSED;
      if (code === 1006) this.emit("error", new Event("error"));
      this.emit(
        "close",
        Object.assign(new Event("close"), {
          code,
          reason: closed ? (closed.closeReason ?? "") : (this.closeRequest?.reason ?? ""),
          wasClean: code !== 1006,
        }),
      );
    });
  }

  private readonly interrupt: () => void;

  /** Bytes are sealed after `send` returns, so the caller must not change them afterwards. */
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState === CONNECTING) {
      throw new DOMException("The socket is still connecting.", "InvalidStateError");
    }
    if (this.readyState !== OPEN || this.outbound === undefined) return;
    if (typeof data === "string") return void Queue.offerUnsafe(this.outbound, data);
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      throw new TypeError("Blob frames are not supported on this socket.");
    }
    Queue.offerUnsafe(
      this.outbound,
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBufferLike),
    );
  }

  close(code?: number, reason?: string) {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    this.closeRequest = { code: code ?? 1005, reason: reason ?? "" };
    if (this.raw === undefined) this.interrupt();
    else this.raw.close(code, reason);
  }

  private emit(type: "open" | "message" | "close" | "error", event: Event) {
    try {
      (this[`on${type}`] as ((event: Event) => void) | null)?.(event);
    } catch (error) {
      // As in a browser, a throwing handler is reported and the socket carries on.
      queueMicrotask(() => {
        throw error;
      });
    }
    this.dispatchEvent(event);
  }
}
