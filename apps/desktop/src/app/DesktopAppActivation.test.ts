// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect } from "vite-plus/test";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const { startDesktopAppControlServer } = DesktopAppActivation;

const openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function makeTarget(stateDir: string, platform: NodeJS.Platform, userId: number | undefined) {
  return resolveDesktopAppControlAddress({
    stateDir,
    platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: NodePath.join,
  });
}

function request(requestId: string, platform: NodeJS.Platform): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: NodePath.join(NodeOS.tmpdir(), "project"),
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  };
}

function startOkServer(target: ReturnType<typeof makeTarget>, userId: number | undefined) {
  return startDesktopAppControlServer({
    ...target,
    userId,
    handle: async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    }),
    cancel: () => undefined,
    onReclaimError: () => undefined,
  }).then((server) => {
    openServers.push(server);
    return server;
  });
}

function exchange(address: string, payload: DesktopAppActivationRequest) {
  return new Promise<DesktopAppActivationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationResponse);
    });
  });
}

describe("desktop app control server", () => {
  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-cancel-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let resolveCanceled: (requestId: string) => void = () => undefined;
        const canceled = new Promise<string>((resolve) => {
          resolveCanceled = resolve;
        });
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: resolveCanceled,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(`${JSON.stringify(request("request-canceled", platform))}\n`, () => {
              socket.destroy();
              resolve();
            });
          });
        });

        await expect(canceled).resolves.toBe("request-canceled");
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("keeps a newer app's socket when an older app on the same state dir quits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-takeover-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const older = await startOkServer(target, userId);
        await startOkServer(target, userId);

        await older.close();

        await expect(
          exchange(target.address, request("after-quit", platform)),
        ).resolves.toMatchObject({ ok: true, requestId: "after-quit" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("binds its address again after the socket file is removed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-reclaim-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startOkServer(target, userId);

        await NodeFSP.unlink(target.address);
        await server.reclaim();

        await expect(
          exchange(target.address, request("reclaimed", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "reclaimed",
        });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect(
    "fails an in-flight request and queues later requests after render-process-gone until ready again",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        const userId = yield* HostProcess.UserId;
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-crash-test-")),
          ),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const stateDir = NodePath.join(root, "userdata");
        const target = makeTarget(stateDir, platform, userId);

        const sent: Array<DesktopAppActivationRequest> = [];
        let resolveFirstDispatched: () => void = () => undefined;
        const firstDispatched = new Promise<void>((resolve) => {
          resolveFirstDispatched = resolve;
        });
        let resolveSecondDispatched: () => void = () => undefined;
        const secondDispatched = new Promise<void>((resolve) => {
          resolveSecondDispatched = resolve;
        });
        let activationCount = 0;
        let resolveSecondActivation: () => void = () => undefined;
        const secondActivated = new Promise<void>((resolve) => {
          resolveSecondActivation = resolve;
        });

        const webContents = Object.assign(new NodeEvents.EventEmitter(), {
          isDestroyed: () => false,
          send: (channel: string, payload: DesktopAppActivationRequest) => {
            if (channel !== DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL) return;
            sent.push(payload);
            if (payload.requestId === "before-crash") resolveFirstDispatched();
            if (payload.requestId === "after-crash") resolveSecondDispatched();
          },
        });
        const window = Option.some({ webContents } as unknown as Electron.BrowserWindow);

        const layer = DesktopAppActivation.layer.pipe(
          Layer.provide(
            Layer.succeed(
              DesktopEnvironment.DesktopEnvironment,
              DesktopEnvironment.DesktopEnvironment.of({
                stateDir,
                platform,
              } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
            ),
          ),
          Layer.provide(
            Layer.succeed(DesktopWindow.DesktopWindow, {
              activate: Effect.sync(() => {
                activationCount += 1;
                if (activationCount === 2) resolveSecondActivation();
              }),
            } as unknown as DesktopWindow.DesktopWindow["Service"]),
          ),
          Layer.provide(
            Layer.succeed(
              ElectronWindow.ElectronWindow,
              ElectronWindow.ElectronWindow.of({
                main: Effect.succeed(window),
              } as unknown as ElectronWindow.ElectronWindow["Service"]),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const activation = yield* DesktopAppActivation.DesktopAppActivation;
          yield* activation.start;
          yield* activation.setRendererReady(true);

          const firstResponse = exchange(target.address, request("before-crash", platform));
          yield* Effect.promise(() => firstDispatched);

          webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });

          const failed = yield* Effect.promise(() => firstResponse);
          expect(failed).toMatchObject({
            ok: false,
            requestId: "before-crash",
            code: "renderer-unavailable",
          });
          expect(webContents.listenerCount("render-process-gone")).toBe(0);

          const secondResponse = exchange(target.address, request("after-crash", platform));
          yield* Effect.promise(() => secondActivated);
          expect(sent.map((entry) => entry.requestId)).toEqual(["before-crash"]);

          yield* activation.setRendererReady(true);
          yield* Effect.promise(() => secondDispatched);
          expect(sent.map((entry) => entry.requestId)).toEqual(["before-crash", "after-crash"]);

          yield* activation.setRendererReady(false);
          expect(webContents.listenerCount("render-process-gone")).toBe(0);
          yield* Effect.promise(() => secondResponse);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );
});
