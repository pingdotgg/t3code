// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
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
});

describe("desktop app control server connection requests", () => {
  it.effect("routes connection requests separately from activation", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-conn-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const activations: string[] = [];
        const connections: string[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            activations.push(input.requestId);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
          handleConnection: async (input) => {
            connections.push(input.requestId);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              result: { environments: [] },
            };
          },
          cancelConnection: () => undefined,
        });
        openServers.push(server);

        const listed = await exchange(target.address, {
          version: 1,
          requestId: "list-1",
          type: "connection",
          operation: "listEnvironments",
        } as unknown as DesktopAppActivationRequest);
        expect(listed).toMatchObject({
          ok: true,
          requestId: "list-1",
          result: { environments: [] },
        });

        const invalid = await exchange(target.address, {
          version: 1,
          requestId: "bad-1",
          type: "connection",
          operation: "dispatch",
          environmentId: "env",
          command: { type: "thread.checkpoint.revert" },
        } as unknown as DesktopAppActivationRequest);
        expect(invalid).toMatchObject({ ok: false, requestId: "bad-1", code: "invalid-request" });

        const activated = await exchange(target.address, request("open-1", platform));
        expect(activated).toMatchObject({ ok: true, requestId: "open-1" });
        expect(activations).toEqual(["open-1"]);
        expect(connections).toEqual(["list-1"]);

        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});

describe("desktop app control server cancellation ownership", () => {
  it.effect("a rejected duplicate id disconnecting never cancels the first request", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-dup-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const cancelled: unknown[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstStarted = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let seen = 0;
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: () => undefined,
          handleConnection: (input) => {
            seen += 1;
            if (seen === 1) {
              releaseFirst();
              return new Promise(() => undefined);
            }
            return Promise.resolve({
              version: 1,
              requestId: input.requestId,
              ok: false,
              code: "invalid-request",
              message: "The request id is already in use.",
            });
          },
          cancelConnection: (request) => cancelled.push(request),
        });
        openServers.push(server);
        const payload = {
          version: 1,
          requestId: "same",
          type: "connection",
          operation: "listEnvironments",
        } as unknown as DesktopAppActivationRequest;

        const first = NodeNet.createConnection(target.address);
        await new Promise<void>((resolve, reject) => {
          first.once("error", reject);
          first.once("connect", () => first.write(`${JSON.stringify(payload)}\n`, () => resolve()));
        });
        await firstStarted;

        const duplicate = await exchange(target.address, payload);
        expect(duplicate).toMatchObject({ ok: false, code: "invalid-request" });
        await new Promise((resolve) => setImmediate(resolve));
        expect(cancelled).toEqual([]);

        first.destroy();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toMatchObject({ requestId: "same", operation: "listEnvironments" });

        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});
