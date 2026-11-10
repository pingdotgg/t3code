// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePathLayer from "@effect/platform-node/NodePath";

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
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { afterEach, describe, expect } from "vite-plus/test";
import type * as Electron from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { make, startDesktopAppControlServer } from "./DesktopAppActivation.ts";

describe("dropped-folder failure warnings", () => {
  it.effect.each([
    { localEnabled: false, hasWindow: true },
    { localEnabled: false, hasWindow: false },
    { localEnabled: true, hasWindow: true },
  ])("uses the current owner when available (%j)", ({ localEnabled, hasWindow }) =>
    Effect.gen(function* () {
      const sent = Promise.withResolvers<DesktopAppActivationRequest>();
      const window = {
        webContents: {
          isDestroyed: () => false,
          on: () => undefined,
          once: () => undefined,
          removeListener: () => undefined,
          send: (_channel: string, request: DesktopAppActivationRequest) => sent.resolve(request),
        },
      } as unknown as Electron.BrowserWindow;
      let owner = Option.none<Electron.BrowserWindow>();
      const warningOwners: Array<Electron.BrowserWindow | undefined> = [];
      const activation = yield* make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir: "/tmp/issue-32640/activation-test",
          platform: "darwin",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(DesktopWindow.DesktopWindow, {
          activate: Effect.void,
        } as unknown as DesktopWindow.DesktopWindow["Service"]),
        Effect.provideService(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.succeed({ localEnvironmentEnabled: localEnabled }),
        } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          main: Effect.succeedSome(window),
          currentMainOrFirst: Effect.sync(() => owner),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          showMessageBox: (_options, owner) =>
            Effect.sync(() => {
              warningOwners.push(owner);
              return { response: 0, checkboxChecked: false };
            }),
        }),
        Effect.provide(NodePathLayer.layerPosix),
      );

      if (localEnabled) {
        yield* activation.setRendererReady(true);
        const opening = yield* activation
          .openWorkspace("/tmp/issue-32640/project")
          .pipe(Effect.forkChild);
        const request = yield* Effect.promise(() => sent.promise);
        owner = Option.some(window);
        yield* activation.complete({
          version: 1,
          requestId: request.requestId,
          ok: false,
          code: "thread-open-failed",
          message: "Could not create the thread.",
        });
        yield* Fiber.join(opening);
      } else {
        owner = hasWindow ? Option.some(window) : Option.none();
        yield* activation.openWorkspace("/tmp/issue-32640/project");
      }

      expect(warningOwners).toEqual([hasWindow ? window : undefined]);
    }),
  );
});

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
});
