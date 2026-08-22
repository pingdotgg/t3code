import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  TCP_PORT_FORWARD_FRAME_ACK,
  TCP_PORT_FORWARD_FRAME_DATA,
  TCP_PORT_FORWARD_FRAME_WRITE_END,
  TCP_PORT_FORWARD_INITIAL_CREDIT,
  type DesktopPortForwardAuthorizationRequest,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeNet from "node:net";
import * as Queue from "effect/Queue";
import { EventEmitter } from "node:events";

import * as DesktopPortForwardManager from "./DesktopPortForwardManager.ts";

const connectLocal = (port: number) =>
  Effect.callback<NodeNet.Socket, Error>((resume) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    const onConnect = () => {
      socket.off("error", onError);
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error) => {
      socket.off("connect", onConnect);
      resume(Effect.fail(cause));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  });

const awaitSocketClose = (socket: NodeNet.Socket) =>
  socket.destroyed
    ? Effect.void
    : Effect.callback<void>((resume) => {
        socket.once("close", () => resume(Effect.void));
      });

const makeAckFrame = (bytes: number) => {
  const frame = new Uint8Array(5);
  frame[0] = TCP_PORT_FORWARD_FRAME_ACK;
  new DataView(frame.buffer).setUint32(1, bytes, false);
  return frame;
};

const makeConnectionSocket = () => {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    destroy: vi.fn(() => socket),
    end: () => socket,
    pause: () => socket,
    resume: () => socket,
    setTimeout: () => socket,
    write: (_payload: Uint8Array, callback: (error?: Error | null) => void) => {
      callback();
      return true;
    },
  });
  return socket as unknown as NodeNet.Socket;
};

const makeConnectionWebSocket = (readyState: number = WebSocket.OPEN) => {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const sent: Array<Uint8Array> = [];
  const webSocket = {
    readyState,
    send: (data: ArrayBuffer) => sent.push(new Uint8Array(data)),
    close: () => undefined,
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    webSocket: webSocket as unknown as WebSocket,
    sent,
    receive: (frame: Uint8Array) => {
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: frame.slice().buffer } as MessageEvent);
      }
    },
  };
};

it.layer(NodeServices.layer)("DesktopPortForwardManager", (it) => {
  it("preserves renderer authorization failures for the forward status", () => {
    const error = new DesktopPortForwardManager.DesktopPortForwardError({
      operation: "authorize",
      detail: "Remote environment returned 404",
    });

    expect(error.message).toBe(
      "Desktop port forward authorize failed: Remote environment returned 404.",
    );
  });

  it.effect("flushes credit-blocked local data before sending write end", () =>
    Effect.gen(function* () {
      const socket = makeConnectionSocket();
      const webSocket = makeConnectionWebSocket();
      const connection = yield* DesktopPortForwardManager.runConnection(
        socket,
        webSocket.webSocket,
      ).pipe(Effect.forkChild({ startImmediately: true }));

      socket.emit("data", Buffer.alloc(TCP_PORT_FORWARD_INITIAL_CREDIT + 1));
      socket.emit("end");
      expect(webSocket.sent.some((frame) => frame[0] === TCP_PORT_FORWARD_FRAME_WRITE_END)).toBe(
        false,
      );

      webSocket.receive(makeAckFrame(TCP_PORT_FORWARD_INITIAL_CREDIT));
      const dataBytes = webSocket.sent
        .filter((frame) => frame[0] === TCP_PORT_FORWARD_FRAME_DATA)
        .reduce((total, frame) => total + frame.byteLength - 1, 0);
      expect(dataBytes).toBe(TCP_PORT_FORWARD_INITIAL_CREDIT + 1);
      expect(webSocket.sent.at(-1)?.[0]).toBe(TCP_PORT_FORWARD_FRAME_WRITE_END);
      yield* Fiber.interrupt(connection);
    }),
  );

  it.effect("closes a local socket when the bridge closed during handoff", () =>
    Effect.gen(function* () {
      const socket = makeConnectionSocket();
      const webSocket = makeConnectionWebSocket(WebSocket.CLOSED);

      yield* DesktopPortForwardManager.runConnection(socket, webSocket.webSocket);

      expect(socket.destroy).toHaveBeenCalled();
    }),
  );

  it.effect("atomically allocates and stops a desktop loopback listener", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const created = yield* manager.create({
        environmentId: EnvironmentId.make("environment-a"),
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });

      expect(created.localHost).toBe("127.0.0.1");
      expect(created.localPort).toBeGreaterThan(0);
      expect(yield* manager.list).toEqual([created]);

      yield* manager.stop(created.id);
      expect(yield* manager.list).toEqual([]);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("stops only forwards owned by the removed environment", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const firstEnvironment = EnvironmentId.make("environment-a");
      const secondEnvironment = EnvironmentId.make("environment-b");
      yield* manager.create({
        environmentId: firstEnvironment,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      const retained = yield* manager.create({
        environmentId: secondEnvironment,
        remoteHost: "127.0.0.1",
        remotePort: 3001,
      });

      yield* manager.stopEnvironment(firstEnvironment);
      expect(yield* manager.list).toEqual([retained]);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("reports an explicit local-port conflict without replacing the owner", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const environmentId = EnvironmentId.make("environment-a");
      const owner = yield* manager.create({
        environmentId,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });

      const conflict = yield* Effect.flip(
        manager.create({
          environmentId,
          remoteHost: "127.0.0.1",
          remotePort: 3001,
          localPort: owner.localPort,
        }),
      );
      expect(conflict._tag).toBe("DesktopPortForwardError");
      expect(yield* manager.list).toEqual([owner]);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("chooses another local port when two environments prefer the same port", () =>
    Effect.gen(function* () {
      const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
      const first = yield* manager.create({
        environmentId: EnvironmentId.make("environment-a"),
        remoteHost: "127.0.0.1",
        remotePort: 42000,
      });
      const second = yield* manager.create({
        environmentId: EnvironmentId.make("environment-b"),
        remoteHost: "127.0.0.1",
        remotePort: first.localPort,
      });

      expect(second.localPort).not.toBe(first.localPort);
      expect(yield* manager.list).toHaveLength(2);
    }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
  );

  it.effect("does not report a local socket as active before its bridge connects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
        const authorization = yield* Deferred.make<DesktopPortForwardAuthorizationRequest>();
        const failed = yield* Deferred.make<void>();

        yield* manager.subscribeAuthorizationRequests((request) =>
          Deferred.succeed(authorization, request).pipe(Effect.asVoid),
        );
        yield* manager.subscribeStateChanges((snapshots) => {
          const snapshot = snapshots[0];
          return snapshot !== undefined &&
            snapshot.connectingConnections === 0 &&
            snapshot.lastError !== null
            ? Deferred.succeed(failed, undefined).pipe(Effect.asVoid)
            : Effect.void;
        });

        const created = yield* manager.create({
          environmentId: EnvironmentId.make("environment-a"),
          remoteHost: "127.0.0.1",
          remotePort: 3000,
        });
        const socket = yield* connectLocal(created.localPort);
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));

        const request = yield* Deferred.await(authorization);
        const [connecting] = yield* manager.list;
        expect(connecting?.connectingConnections).toBe(1);
        expect(connecting?.activeConnections).toBe(0);

        yield* manager.resolveAuthorization(request.requestId, "not a valid WebSocket URL");
        yield* Deferred.await(failed);

        const [settled] = yield* manager.list;
        expect(settled?.connectingConnections).toBe(0);
        expect(settled?.activeConnections).toBe(0);
        expect(settled?.lastError).toContain("validate-ticket-url");
      }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
    ),
  );

  it.effect("keeps the listener but retires connecting sockets when the route changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
        const environmentId = EnvironmentId.make("environment-a");
        const authorizations = yield* Queue.unbounded<DesktopPortForwardAuthorizationRequest>();
        yield* manager.subscribeAuthorizationRequests((request) =>
          Queue.offer(authorizations, request).pipe(Effect.asVoid),
        );
        const created = yield* manager.create({
          environmentId,
          remoteHost: "127.0.0.1",
          remotePort: 3000,
        });

        const firstSocket = yield* connectLocal(created.localPort);
        const firstAuthorization = yield* Queue.take(authorizations);
        expect((yield* manager.list)[0]?.connectingConnections).toBe(1);

        yield* manager.resetEnvironmentConnections(environmentId);
        yield* awaitSocketClose(firstSocket);
        yield* manager.resolveAuthorization(
          firstAuthorization.requestId,
          "ws://127.0.0.1:1/ws/tcp-forward?ticket=stale",
        );

        const [reset] = yield* manager.list;
        expect(reset).toMatchObject({
          id: created.id,
          localPort: created.localPort,
          status: "running",
          connectingConnections: 0,
          activeConnections: 0,
          lastError: null,
        });

        const secondSocket = yield* connectLocal(created.localPort);
        const secondAuthorization = yield* Queue.take(authorizations);
        expect(secondAuthorization.requestId).not.toBe(firstAuthorization.requestId);
        yield* manager.resetEnvironmentConnections(environmentId);
        yield* awaitSocketClose(secondSocket);
      }).pipe(Effect.provide(DesktopPortForwardManager.layer)),
    ),
  );
});
