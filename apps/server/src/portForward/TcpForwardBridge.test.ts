import {
  AuthSessionId,
  TCP_PORT_FORWARD_FRAME_ACK,
  TCP_PORT_FORWARD_FRAME_DATA,
  TCP_PORT_FORWARD_FRAME_WRITE_END,
  TCP_PORT_FORWARD_INITIAL_CREDIT,
  TCP_PORT_FORWARD_MAX_DATA_SIZE,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeNet from "node:net";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { EventEmitter } from "node:events";

import * as SessionStore from "../auth/SessionStore.ts";
import {
  makeConnectTarget,
  makeTargetResource,
  runBridge,
  subscribeAndVerifySession,
} from "./TcpForwardBridge.ts";

const createSocket = (result: "connect" | "error") => {
  const socket = new NodeNet.Socket();
  queueMicrotask(() => {
    if (result === "connect") socket.emit("connect");
    else socket.emit("error", new Error("connection refused"));
  });
  return socket;
};

const makeAckFrame = (bytes: number) => {
  const frame = new Uint8Array(5);
  frame[0] = TCP_PORT_FORWARD_FRAME_ACK;
  new DataView(frame.buffer).setUint32(1, bytes, false);
  return frame;
};

const makeDataFrame = (bytes: number) => {
  const frame = new Uint8Array(bytes + 1);
  frame[0] = TCP_PORT_FORWARD_FRAME_DATA;
  return frame;
};

const makeBridgeTarget = () => {
  const emitter = new EventEmitter();
  let destroyed = false;
  const writeCallbacks: Array<(error?: Error | null) => void> = [];
  const target = Object.assign(emitter, {
    end: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setTimeout: vi.fn(),
    write: vi.fn((_payload: Uint8Array, callback: (error?: Error | null) => void) => {
      writeCallbacks.push(callback);
      return false;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  });
  Object.defineProperty(target, "destroyed", { get: () => destroyed });
  return { target: target as unknown as NodeNet.Socket, writeCallbacks };
};

it("connects to IPv6 loopback when the IPv4 loopback target is unavailable", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket(host === "::1" ? "connect" : "error");
  });

  const target = await Effect.runPromise(makeConnectTarget(createConnection)("127.0.0.1", 5173));

  expect(attemptedHosts).toEqual(["127.0.0.1", "::1"]);
  expect(createConnection).toHaveBeenCalledWith({
    host: "127.0.0.1",
    port: 5173,
    allowHalfOpen: true,
  });
  expect(createConnection).toHaveBeenCalledWith({ host: "::1", port: 5173, allowHalfOpen: true });
  target.destroy();
});

it("keeps IPv4 loopback as the first target when it is available", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket("connect");
  });

  const target = await Effect.runPromise(makeConnectTarget(createConnection)("127.0.0.1", 5173));

  expect(attemptedHosts).toEqual(["127.0.0.1"]);
  target.destroy();
});

it("keeps an error handler installed while handing off a connected target", async () => {
  const target = await Effect.runPromise(
    makeConnectTarget(() => createSocket("connect"))("127.0.0.1", 5173),
  );

  expect(() => target.emit("error", new Error("reset during handoff"))).not.toThrow();
  expect(target.destroyed).toBe(true);
});

it("fails after both loopback addresses are unavailable", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket("error");
  });

  const failure = await Effect.runPromise(
    Effect.flip(makeConnectTarget(createConnection)("127.0.0.1", 5173)),
  );
  expect(failure).toMatchObject({ host: "127.0.0.1", port: 5173 });
  expect(failure.cause).toBeInstanceOf(AggregateError);
  expect((failure.cause as AggregateError).errors).toMatchObject([
    { host: "127.0.0.1", port: 5173 },
    { host: "::1", port: 5173 },
  ]);
  expect(attemptedHosts).toEqual(["127.0.0.1", "::1"]);
});

it("does not expand non-loopback targets to IPv6 loopback", async () => {
  const attemptedHosts: Array<string> = [];
  const createConnection = vi.fn(({ host }: { host: string; port: number }) => {
    attemptedHosts.push(host);
    return createSocket("error");
  });

  await expect(
    Effect.runPromise(makeConnectTarget(createConnection)("192.0.2.1", 5173)),
  ).rejects.toBeDefined();
  expect(attemptedHosts).toEqual(["192.0.2.1"]);
});

it.effect("subscribes to revocations before re-verifying the consumed session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
      const session = {
        sessionId: AuthSessionId.make("session-a"),
        token: "websocket-token",
        scopes: ["terminal:operate"],
      } as unknown as SessionStore.VerifiedSession;
      const sessions = {
        subscribeChanges: PubSub.subscribe(changes),
        verifyWebSocketToken: () =>
          PubSub.publish(changes, {
            type: "clientRemoved" as const,
            sessionId: session.sessionId,
          }).pipe(Effect.as(session)),
      };

      const watcher = yield* subscribeAndVerifySession(sessions, session);
      const observed = yield* PubSub.take(watcher.changes);

      expect(observed).toEqual({
        type: "clientRemoved",
        sessionId: session.sessionId,
      });
    }),
  ),
);

it.effect("destroys an acquired target when a later upgrade step fails", () =>
  Effect.gen(function* () {
    const { target } = makeBridgeTarget();
    const acquireTarget = makeTargetResource(() => Effect.succeed(target));

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* acquireTarget("127.0.0.1", 5173);
        return yield* Effect.fail("upgrade failed");
      }),
    ).pipe(Effect.flip);

    expect(target.destroyed).toBe(true);
  }),
);

it.effect("flushes credit-blocked target data before sending write end", () =>
  Effect.gen(function* () {
    const handlerReady = yield* Deferred.make<void>();
    const initialWindowSent = yield* Deferred.make<void>();
    const writeEndSent = yield* Deferred.make<void>();
    const sentDataBytes = yield* Ref.make(0);
    let receiveFrame: ((frame: Uint8Array) => void) | undefined;
    const webSocket = {
      writer: Effect.succeed((frame: Uint8Array | Socket.CloseEvent) =>
        frame instanceof Uint8Array
          ? Effect.gen(function* () {
              if (frame[0] === TCP_PORT_FORWARD_FRAME_DATA) {
                const total = yield* Ref.updateAndGet(
                  sentDataBytes,
                  (current) => current + frame.byteLength - 1,
                );
                if (total === TCP_PORT_FORWARD_INITIAL_CREDIT) {
                  yield* Deferred.succeed(initialWindowSent, undefined);
                }
              } else if (frame[0] === TCP_PORT_FORWARD_FRAME_WRITE_END) {
                yield* Deferred.succeed(writeEndSent, undefined);
              }
            })
          : Effect.void,
      ),
      run: (handler: (frame: Uint8Array) => void) => {
        receiveFrame = handler;
        return Deferred.succeed(handlerReady, undefined).pipe(Effect.andThen(Effect.never));
      },
    } as unknown as Socket.Socket;
    const { target } = makeBridgeTarget();
    const bridge = yield* runBridge(webSocket, target).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(handlerReady);

    target.emit("data", Buffer.alloc(TCP_PORT_FORWARD_INITIAL_CREDIT + 1));
    target.emit("end");
    yield* Deferred.await(initialWindowSent);
    expect(Option.isNone(yield* Deferred.poll(writeEndSent))).toBe(true);

    receiveFrame?.(makeAckFrame(TCP_PORT_FORWARD_INITIAL_CREDIT));
    yield* Deferred.await(writeEndSent);
    expect(yield* Ref.get(sentDataBytes)).toBe(TCP_PORT_FORWARD_INITIAL_CREDIT + 1);
    yield* Fiber.interrupt(bridge);
  }),
);

it.effect("rejects data beyond the advertised receive-credit window", () =>
  Effect.gen(function* () {
    const handlerReady = yield* Deferred.make<void>();
    let receiveFrame: ((frame: Uint8Array) => void) | undefined;
    const webSocket = {
      writer: Effect.succeed(() => Effect.void),
      run: (handler: (frame: Uint8Array) => void) => {
        receiveFrame = handler;
        return Deferred.succeed(handlerReady, undefined).pipe(Effect.andThen(Effect.never));
      },
    } as unknown as Socket.Socket;
    const { target } = makeBridgeTarget();
    const bridge = yield* runBridge(webSocket, target).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(handlerReady);

    let remaining = TCP_PORT_FORWARD_INITIAL_CREDIT;
    while (remaining > 0) {
      const size = Math.min(remaining, TCP_PORT_FORWARD_MAX_DATA_SIZE);
      receiveFrame?.(makeDataFrame(size));
      remaining -= size;
    }
    expect(target.write).toHaveBeenCalled();
    expect(target.destroyed).toBe(false);

    receiveFrame?.(makeDataFrame(1));
    expect(target.destroyed).toBe(true);
    yield* Fiber.interrupt(bridge);
  }),
);
