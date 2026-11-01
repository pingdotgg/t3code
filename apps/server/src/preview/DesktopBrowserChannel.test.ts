import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

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

const fakeDesktop = Effect.gen(function* () {
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
      write: (chunk) => Effect.sync(() => void written.push(chunk)),
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
      const desktop = yield* fakeDesktop;
      yield* Queue.offer(desktop.frames, attached);
      const session = yield* Effect.scoped(channel.serveSocket(desktop.socket)).pipe(
        Effect.forkChild,
      );

      expect(yield* channel.awaitAttached(key, "1 second")).toBe(true);
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
    }),
  );

  it.effect("closes the socket a reconnecting desktop replaces and ignores its frames", () =>
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const stale = yield* fakeDesktop;
      const fresh = yield* fakeDesktop;
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
});
