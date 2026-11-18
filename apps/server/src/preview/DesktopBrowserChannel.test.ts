import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

vi.mock("@effect/platform-node/NodeStream", () => ({ fromReadable: vi.fn() }));
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

      const shown = yield* channel.awaitShown(key, "5 seconds").pipe(Effect.forkChild);
      yield* send({ type: "shown", ...key, shown: true });
      expect(yield* Fiber.join(shown)).toBe(true);
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

it.effect(
  "a desktop without fds attaches its tabs over a socket, and loses them when it drops",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
        const key = { threadId: "thread-1", tabId: "tab-1" };
        const connect = Effect.gen(function* () {
          const frames = yield* Queue.unbounded<string, Cause.Done>();
          const commands = yield* Queue.unbounded<string>();
          const socket = Socket.make({
            reader: Effect.succeed({
              pull: Queue.take(frames).pipe(
                Effect.map((frame) => [frame] as const),
                Effect.mapError(
                  () =>
                    new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
                ),
              ),
              upgrade: () => Effect.void,
            }),
            writer: Effect.succeed({
              write: (chunk) =>
                typeof chunk === "string" ? Queue.offer(commands, chunk) : Effect.void,
              writeAll: () => Effect.void,
            }),
          });
          const served = yield* channel.serve(socket).pipe(Effect.forkChild);
          const send = (event: object) => Queue.offer(frames, JSON.stringify(event));
          return { frames, commands, served, send };
        });
        expect(channel.available).toBe(true);

        const first = yield* connect;
        yield* first.send({ type: "attached", ...key });
        expect(yield* channel.awaitAttached(key, "5 seconds")).toBe(true);
        // The desktop redials before the first socket's close is seen, while an endpoint is open.
        const second = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* channel.endpoint(key);
            const detached = yield* channel.detached.pipe(Stream.runHead, Effect.forkChild);
            const replacement = yield* connect;
            yield* Fiber.join(detached);
            expect(yield* channel.isAttached(key)).toBe(false);
            yield* replacement.send({ type: "attached", ...key });
            expect(yield* channel.awaitAttached(key, "5 seconds")).toBe(true);
            return replacement;
          }),
        );
        // Neither the old endpoint's release nor the first socket's late close reaches the new tab.
        yield* Queue.end(first.frames);
        yield* Fiber.join(first.served);
        expect(yield* channel.isAttached(key)).toBe(true);
        yield* channel.pointer(key, { phase: "move", x: 1, y: 2 });
        expect(JSON.parse(yield* Queue.take(second.commands))).toEqual({
          type: "pointer",
          ...key,
          phase: "move",
          x: 1,
          y: 2,
        });
        expect(yield* Queue.size(first.commands)).toBe(0);

        yield* Queue.end(second.frames);
        yield* Fiber.join(second.served);
        expect(yield* channel.isAttached(key)).toBe(false);
      }).pipe(
        Effect.provide(
          DesktopBrowserChannel.layer.pipe(
            Layer.provide(ServerConfig.layer({ ...config, desktopBrowserSocket: true })),
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
