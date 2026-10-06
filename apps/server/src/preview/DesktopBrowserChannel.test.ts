// @effect-diagnostics nodeBuiltinImport:off - The channel reads real file descriptors.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

const key = { threadId: "thread-1", tabId: "tab-1" };

/** The channel over two files: what the desktop sent, and where commands go. */
const channelOver = (events: ReadonlyArray<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-browser-channel-")),
      ),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const inbound = NodePath.join(directory, "events.ndjson");
    NodeFS.writeFileSync(inbound, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    const control = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(NodePath.join(directory, "commands.ndjson"), "w")),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    );
    const base = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-browser-" })),
    );
    const config = Layer.succeed(ServerConfig.ServerConfig, {
      ...base,
      desktopBrowserFd: NodeFS.openSync(inbound, "r"),
      desktopBrowserControlFd: control,
    });
    // Built in the caller's scope, so the channel outlives this setup.
    const context = yield* Layer.build(DesktopBrowserChannel.layer.pipe(Layer.provide(config)));
    return Context.get(context, DesktopBrowserChannel.DesktopBrowserChannel);
  });

it.layer(NodeServices.layer)("DesktopBrowserChannel", (it) => {
  it.effect("refuses an endpoint for a tab that is no longer attached", () =>
    Effect.gen(function* () {
      const channel = yield* channelOver([
        { type: "attached", ...key },
        { type: "detached", ...key },
      ]);
      // Whether or not the reader has reached these lines yet, the tab is not attached.
      const exit = yield* Effect.exit(Effect.scoped(channel.endpoint(key)));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

const channelUrl = new URL("./DesktopBrowserChannel.ts", import.meta.url);

it("lets the server exit after a crash while the desktop holds the channel open", async () => {
  // fd 3 is the desktop's event pipe and fd 4 its command pipe, both held open and idle
  // the way the desktop app keeps them between browser events.
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const url = ${JSON.stringify(channelUrl.href)};
const Channel = await import(url);
const Config = await import(new URL("../config.ts", url));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const base = Context.get(
    yield* Layer.build(Config.layerTest(process.cwd(), { prefix: "t3-desktop-browser-exit-" }).pipe(Layer.provide(NodeServices.layer))),
    Config.ServerConfig,
  );
  yield* Layer.build(Channel.layer.pipe(Layer.provide(Layer.succeed(Config.ServerConfig, {
    ...base, desktopBrowserFd: 3, desktopBrowserControlFd: 4,
  }))));
  setImmediate(() => { throw new Error("server crashed"); });
  yield* Effect.never;
})));`,
    ],
    {
      cwd: new URL("../../", channelUrl),
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      // Fails a hung regression, never paces success: a passing run resolves on the child's exit.
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  expect(stderr).toContain("server crashed");
  expect(signal).toBeNull();
  expect(code).toBe(1);
}, 120_000);
