// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppControlResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import { startDesktopAppControlServer } from "./DesktopAppActivation.ts";

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

function openThreadRequest(
  requestId: string,
  platform: NodeJS.Platform,
): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-thread",
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
    environmentId: EnvironmentId.make("primary"),
    threadId: ThreadId.make("thread-1"),
  };
}

function exchange(address: string, payload: unknown) {
  return new Promise<DesktopAppControlResponse>((resolve, reject) => {
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
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopAppControlResponse);
    });
  });
}

describe("desktop app control server", () => {
  it.effect("roundtrips a request and removes its socket on shutdown", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-control-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, request("request-1", platform));

        expect(received).toHaveLength(1);
        expect(response).toMatchObject({ ok: true, requestId: "request-1" });
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        if (target.directory !== null) {
          await expect(NodeFSP.stat(target.address)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
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

  it.effect("answers a capabilities probe without invoking activation", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-probe-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, {
          version: 1,
          requestId: "probe-1",
          type: "get-capabilities",
        });

        expect(received).toHaveLength(0);
        expect(response).toEqual({
          version: 1,
          requestId: "probe-1",
          ok: true,
          type: "capabilities",
          operations: ["open-workspace", "open-thread"],
          environmentScope: "primary",
        });

        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("roundtrips an existing-thread request", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-thread-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              environmentId: EnvironmentId.make("primary"),
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, openThreadRequest("thread-1", platform));

        expect(received).toEqual([openThreadRequest("thread-1", platform)]);
        expect(response).toMatchObject({
          ok: true,
          requestId: "thread-1",
          environmentId: "primary",
          projectId: "project-1",
          threadId: "thread-1",
        });

        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("rejects a malformed control request", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-invalid-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, {
          version: 1,
          requestId: "bad-1",
          type: "open-thread",
        });

        expect(received).toHaveLength(0);
        expect(response).toMatchObject({ ok: false, code: "invalid-request" });

        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});
