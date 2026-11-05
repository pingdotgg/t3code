import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

vi.mock("@effect/platform-node/NodeStream", () => ({ fromReadable: vi.fn() }));
vi.mock("node:net", () => ({
  Socket: class {
    destroy() {}
  },
}));
vi.mock("../resourceTelemetry/DesktopTelemetryReceiver.ts", () => ({
  writeAllToFileDescriptor: vi.fn(),
}));

const withChannel = <A, E>(
  body: (
    channel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
    send: (event: object) => Effect.Effect<boolean>,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
    const config = yield* ServerConfig.ServerConfig;
    const send = (event: object) =>
      Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    return yield* Effect.gen(function* () {
      return yield* body(yield* DesktopBrowserChannel.DesktopBrowserChannel, send);
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
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("protects unknown desktop visibility until an explicit hidden report arrives", () =>
  withChannel((channel, send) =>
    Effect.gen(function* () {
      vi.mocked(writeAllToFileDescriptor).mockReturnValue(Effect.void);
      const key = { threadId: "thread-1", tabId: "tab-1" };

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
    }),
  ),
);

it.live("a replaced endpoint's shutdown does not release the endpoint that replaced it", () =>
  withChannel((channel, send) =>
    Effect.gen(function* () {
      const key = { threadId: "thread-1", tabId: "tab-1" };
      const commands = yield* Queue.unbounded<{ readonly type: string }>();
      vi.mocked(writeAllToFileDescriptor).mockImplementation((_fd, buffer) =>
        Queue.offer(commands, JSON.parse(buffer.toString())).pipe(Effect.asVoid),
      );

      yield* send({ type: "attached", ...key });
      expect(yield* channel.awaitAttached(key, "5 seconds")).toBe(true);
      const first = yield* Scope.make();
      yield* channel.endpoint(key, { popups: true }).pipe(Scope.provide(first));
      expect((yield* Queue.take(commands)).type).toBe("popups");

      // The desktop recovers a dropped debugger: the tab detaches and attaches again, and the
      // reconnect opens its endpoint before the dropped connection finishes closing.
      const detached = yield* channel.detached.pipe(
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* send({ type: "detached", ...key });
      yield* Fiber.join(detached);
      yield* send({ type: "attached", ...key });
      expect(yield* channel.awaitAttached(key, "5 seconds")).toBe(true);
      const second = yield* Scope.make();
      yield* channel.endpoint(key, { popups: true }).pipe(Scope.provide(second));
      expect((yield* Queue.take(commands)).type).toBe("popups");

      yield* Scope.close(first, Exit.void);
      yield* Scope.close(second, Exit.void);
      // Commands are written in order, so everything the two closes sent precedes this one.
      yield* channel.turn(key.threadId, false);
      const sent: Array<string> = [];
      while (sent.at(-1) !== "turn") sent.push((yield* Queue.take(commands)).type);
      expect(sent).toEqual(["release", "turn"]);
    }),
  ),
);
