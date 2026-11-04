// @effect-diagnostics nodeBuiltinImport:off - The channel reads and writes real desktop fds.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

const key = { threadId: "thread-1", tabId: "tab-1" };

/** FIFOs stand in for the bootstrap fds the desktop passes the backend. */
const desktopPipes = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-browser-"));
    const eventsPath = NodePath.join(dir, "events");
    const controlPath = NodePath.join(dir, "control");
    NodeChildProcess.execFileSync("mkfifo", [eventsPath, controlPath]);
    // Read-write opens never block waiting for the other end.
    const eventsFd = NodeFS.openSync(eventsPath, NodeFS.constants.O_RDWR);
    const controlFd = NodeFS.openSync(controlPath, NodeFS.constants.O_RDWR);
    const control = new NodeNet.Socket({
      fd: NodeFS.openSync(controlPath, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK),
      readable: true,
      writable: false,
    });
    return { dir, eventsFd, controlFd, control };
  }),
  ({ dir, controlFd, control }) =>
    Effect.sync(() => {
      control.destroy();
      NodeFS.closeSync(controlFd);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }),
);

it.live("a replaced endpoint's shutdown does not release the endpoint that replaced it", () =>
  Effect.gen(function* () {
    const pipes = yield* desktopPipes;
    const commands = yield* Queue.unbounded<{ readonly type: string }>();
    let buffered = "";
    pipes.control.on("data", (chunk: Buffer) => {
      const lines = (buffered + chunk.toString()).split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) Queue.offerUnsafe(commands, JSON.parse(line));
    });
    const emit = (event: object) => NodeFS.writeSync(pipes.eventsFd, `${JSON.stringify(event)}\n`);

    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-browser-channel-" }),
      ),
    );
    const channel = Context.get(
      yield* Layer.build(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({
              ...config,
              desktopBrowserFd: pipes.eventsFd,
              desktopBrowserControlFd: pipes.controlFd,
            }),
          ),
        ),
      ),
      DesktopBrowserChannel.DesktopBrowserChannel,
    );

    emit({ type: "attached", ...key });
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
    emit({ type: "detached", ...key });
    yield* Fiber.join(detached);
    emit({ type: "attached", ...key });
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
