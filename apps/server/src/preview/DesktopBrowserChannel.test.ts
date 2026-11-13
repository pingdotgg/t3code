import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as NetAddress from "effect/net/NetAddress";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

vi.mock("@effect/platform-node/NodeStream", () => ({ fromReadable: vi.fn() }));
vi.mock("@effect/platform-node/NodeSocketServer", async (importOriginal) => {
  const original = await importOriginal<typeof NodeSocketServer>();
  return { makeWebSocket: vi.fn(original.makeWebSocket) };
});
vi.mock("node:net", () => ({
  Socket: class {
    destroy() {}
  },
}));

it.effect("protects unknown desktop visibility until an explicit hidden report arrives", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };
      const send = (event: object) =>
        Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      expect(channel.isShown(key)).toBe(true);
      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-1" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-1" }, "5 seconds");
      expect(channel.isShown(key)).toBe(false);

      yield* send({ type: "shown", ...key, shown: true });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-2" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-2" }, "5 seconds");
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "detached", ...key });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-3" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-3" }, "5 seconds");
      expect(channel.isShown(key)).toBe(true);
    }).pipe(
      Effect.provide(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, desktopBrowserFd: 41, desktopBrowserControlFd: 42 }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.live("closes a tab's relay connection when the desktop detaches the tab", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };
      const send = (event: object) =>
        Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      const url = yield* channel.endpoint(key);
      const socket = new WebSocket(url);
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve()),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => socket.addEventListener("open", () => resolve())),
      );

      // Playwright waits on this socket for CDP replies; it must learn the tab is gone.
      yield* send({ type: "detached", ...key });
      yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, desktopBrowserFd: 41, desktopBrowserControlFd: 42 }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
const SECRET = "desktop-browser-socket-secret";
const key = { threadId: "thread-1", tabId: "tab-1" };
const attached = JSON.stringify({ type: "attached", ...key });

const layer = DesktopBrowserChannel.layer.pipe(
  Layer.provide(
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return ServerConfig.make({ ...config, desktopBrowserSocketSecret: SECRET });
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-browser-" }))),
  ),
  Layer.provide(NodeServices.layer),
);

const fakeDesktop = (onClose: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<string>();
    // One entry per read; the server reads again only once it has handled the previous frame.
    const pulls = yield* Queue.unbounded<void>();
    const written: Array<string | Uint8Array | Socket.CloseEvent> = [];
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Queue.offer(pulls, undefined).pipe(
          Effect.andThen(Queue.take(frames)),
          Effect.orDie,
          Effect.map((frame) => [frame] as const),
        ),
        upgrade: () => Effect.die("unused"),
      }),
      writer: Effect.succeed({
        write: (chunk) =>
          Effect.sync(() => void written.push(chunk)).pipe(
            Effect.andThen(chunk instanceof Socket.CloseEvent ? onClose : Effect.void),
          ),
        writeAll: (chunks) => Effect.sync(() => void written.push(...chunks)),
      }),
    });
    const commands = () =>
      written.filter((chunk) => typeof chunk === "string").map((line) => JSON.parse(line));
    const awaitPulls = (count: number) =>
      Effect.forEach(Array.from({ length: count }), () => Queue.take(pulls), { discard: true });
    return { frames, written, socket, commands, awaitPulls };
  });

it.layer(layer)("DesktopBrowserChannel over a desktop socket", (it) => {
  it.effect("authorizes only an upgrade that presents the bootstrap secret", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;

      expect(channel.acceptsSocket).toBe(true);
      expect(channel.authorizesSocket(SECRET)).toBe(true);
      expect(channel.authorizesSocket(`${SECRET}x`)).toBe(false);
      expect(channel.authorizesSocket(undefined)).toBe(false);
    }),
  );

  it.effect("carries tabs and commands until the desktop disconnects", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const desktop = yield* fakeDesktop();
      const loadFailure = {
        url: "https://missing.example/",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      };
      yield* Queue.offer(
        desktop.frames,
        [
          attached,
          JSON.stringify({ type: "loadFailed", ...key, ...loadFailure }),
          JSON.stringify({ type: "shown", ...key, shown: false }),
        ].join("\n"),
      );
      const session = yield* Effect.scoped(channel.serveSocket(desktop.socket)).pipe(
        Effect.forkChild,
      );

      yield* desktop.awaitPulls(2);
      expect(yield* channel.isAttached(key)).toBe(true);
      expect(channel.loadFailure(key)).toEqual(loadFailure);
      expect(channel.isShown(key)).toBe(false);
      yield* channel.pointer(key, { phase: "click", x: 1, y: 2 });
      expect(desktop.commands()).toContainEqual({
        type: "pointer",
        ...key,
        phase: "click",
        x: 1,
        y: 2,
      });

      // A dropped socket reports no detaches; the desktop announces its tabs again on reconnect.
      yield* Fiber.interrupt(session);
      expect(yield* channel.isAttached(key)).toBe(false);
      expect(channel.loadFailure(key)).toBeUndefined();
      expect(channel.isShown(key)).toBe(true);
    }),
  );

  it.effect("closes the socket a reconnecting desktop replaces and ignores its frames", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const stale = yield* fakeDesktop();
      const fresh = yield* fakeDesktop();
      yield* channel.turn(key.threadId, true);
      yield* Queue.offer(stale.frames, attached);
      const staleSession = yield* Effect.scoped(channel.serveSocket(stale.socket)).pipe(
        Effect.forkChild,
      );
      yield* stale.awaitPulls(2);
      expect(yield* channel.isAttached(key)).toBe(true);

      const endpointScope = yield* Scope.make();
      yield* channel.endpoint(key).pipe(Scope.provide(endpointScope));

      const freshSession = yield* Effect.scoped(channel.serveSocket(fresh.socket)).pipe(
        Effect.forkChild,
      );
      yield* fresh.awaitPulls(1);
      expect(stale.written).toContainEqual(expect.objectContaining({ code: 1000 }));
      expect(yield* channel.isAttached(key)).toBe(false);

      yield* Queue.offer(fresh.frames, attached);
      yield* fresh.awaitPulls(1);
      expect(fresh.commands()).toContainEqual({
        type: "turn",
        threadId: key.threadId,
        active: true,
      });
      yield* Scope.close(endpointScope, Exit.void);
      expect(fresh.commands()).not.toContainEqual({ type: "release", ...key });

      yield* Queue.offer(stale.frames, attached);
      yield* stale.awaitPulls(1);
      expect(yield* channel.isAttached(key)).toBe(true);
      yield* channel.pointer(key, { phase: "move", x: 3, y: 4 });
      expect(fresh.commands()).toContainEqual(expect.objectContaining({ type: "pointer" }));
      expect(stale.commands()).toEqual([{ type: "turn", threadId: key.threadId, active: true }]);

      yield* channel.turn(key.threadId, false);
      yield* Queue.offer(fresh.frames, attached);
      yield* fresh.awaitPulls(1);
      expect(fresh.commands().filter((command) => command.type === "turn")).toEqual([
        { type: "turn", threadId: key.threadId, active: true },
        { type: "turn", threadId: key.threadId, active: false },
      ]);

      yield* Fiber.interrupt(staleSession);
      yield* Fiber.interrupt(freshSession);
    }),
  );

  it.effect("keeps the newest desktop attached when an older replacement finishes closing", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const closeStarted = yield* Deferred.make<void>();
      const resumeClose = yield* Deferred.make<void>();
      const stale = yield* fakeDesktop(
        Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Deferred.await(resumeClose))),
      );
      const middle = yield* fakeDesktop();
      const fresh = yield* fakeDesktop();
      yield* Queue.offer(stale.frames, attached);
      const staleSession = yield* Effect.scoped(channel.serveSocket(stale.socket)).pipe(
        Effect.forkChild,
      );
      yield* stale.awaitPulls(2);
      const middleSession = yield* Effect.scoped(channel.serveSocket(middle.socket)).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(closeStarted);
      const freshSession = yield* Effect.scoped(channel.serveSocket(fresh.socket)).pipe(
        Effect.forkChild,
      );
      yield* Queue.offer(
        fresh.frames,
        [attached, JSON.stringify({ type: "shown", ...key, shown: false })].join("\n"),
      );
      yield* fresh.awaitPulls(2);
      expect(yield* channel.isAttached(key)).toBe(true);
      expect(channel.isShown(key)).toBe(false);

      yield* Deferred.succeed(resumeClose, undefined);
      yield* Effect.raceFirst(middle.awaitPulls(1), Fiber.join(middleSession));
      expect(yield* channel.isAttached(key)).toBe(true);
      expect(channel.isShown(key)).toBe(false);
      yield* Fiber.interrupt(middleSession);
      expect(yield* channel.isAttached(key)).toBe(true);
      yield* Fiber.interrupt(staleSession);
      yield* Fiber.interrupt(freshSession);
    }),
  );

  it.effect("binds a relay opened across reconnect to the replacement desktop", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const stale = yield* fakeDesktop();
      const fresh = yield* fakeDesktop();
      const relay = yield* fakeDesktop();
      const opening = yield* Deferred.make<void>();
      const resumeOpening = yield* Deferred.make<void>();
      const relayServer: SocketServer.SocketServer["Service"] = {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 1234),
        run: (handler) => handler(relay.socket).pipe(Effect.orDie, Effect.andThen(Effect.never)),
      };
      using _relayServer = vi
        .spyOn(NodeSocketServer, "makeWebSocket")
        .mockReturnValue(
          Deferred.succeed(opening, undefined).pipe(
            Effect.andThen(Deferred.await(resumeOpening)),
            Effect.as(relayServer),
          ),
        );
      yield* Queue.offer(stale.frames, attached);
      const staleSession = yield* Effect.scoped(channel.serveSocket(stale.socket)).pipe(
        Effect.forkChild,
      );
      yield* stale.awaitPulls(2);
      const endpointScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const endpoint = yield* channel
        .endpoint(key)
        .pipe(Scope.provide(endpointScope), Effect.forkChild);
      yield* Deferred.await(opening);
      yield* Queue.offer(fresh.frames, attached);
      const freshSession = yield* Effect.scoped(channel.serveSocket(fresh.socket)).pipe(
        Effect.forkChild,
      );
      yield* fresh.awaitPulls(2);
      yield* Deferred.succeed(resumeOpening, undefined);
      yield* Fiber.join(endpoint);
      yield* relay.awaitPulls(1);
      const message = JSON.stringify({ id: 1, method: "Page.enable" });
      yield* Queue.offer(relay.frames, message);
      yield* relay.awaitPulls(1);
      expect(fresh.commands()).toContainEqual({ type: "cdp", ...key, message });
      expect(stale.commands()).not.toContainEqual({ type: "cdp", ...key, message });
      yield* Scope.close(endpointScope, Exit.void);
      expect(fresh.commands()).toContainEqual({ type: "release", ...key });
      yield* Fiber.interrupt(staleSession);
      yield* Fiber.interrupt(freshSession);
    }),
  );
});
