// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - drives the proxy as a real Node child process over raw MCP JSON-RPC lines.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { endCuaSession, ensureCuaMcpProxy } from "./CuaMcpProxy.ts";

// Stands in for `cua-driver mcp`: answers `initialize`, reports its pid and
// whether the handshake finished, and answers "hang" only as it is stopped.
// With REFUSE_REPLAY set, it refuses the handshake the proxy replays.
const FAKE_DRIVER = `
let initialized = false;
let hanging = null;
let input = "";
const reply = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\\n");
  input = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === "initialize" && process.env.REFUSE_REPLAY && String(message.id).startsWith("t3-replay")) {
      reply({ id: message.id, error: { code: -32603, message: "refused" } });
    } else if (message.method === "initialize") {
      reply({ id: message.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (message.method === "notifications/initialized") initialized = true;
    if (message.method === "tools/call" && message.params.name === "hang") hanging = message.id;
    if (message.method === "tools/call" && message.params.name === "whoami") {
      reply({ id: message.id, result: { pid: process.pid, initialized } });
    }
  }
});
process.on("SIGTERM", () => {
  if (hanging !== null) reply({ id: hanging, result: { late: true } });
  process.exit(0);
});
`;

const temporaryDirs: Array<string> = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const startProxy = Effect.fn(function* (driverEnv: Record<string, string> = {}) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cua-proxy-"));
  temporaryDirs.push(dir);
  const driverScript = NodePath.join(dir, "fake-driver.mjs");
  NodeFS.writeFileSync(driverScript, FAKE_DRIVER);
  const driver = NodePath.join(dir, "cua-driver");
  NodeFS.writeFileSync(driver, `#!/bin/sh\nexec "${process.execPath}" "${driverScript}" "$@"\n`);
  NodeFS.chmodSync(driver, 0o755);
  const proxyPath = yield* ensureCuaMcpProxy(dir);
  const control = NodePath.join(dir, "control.sock");
  const proxy = NodeChildProcess.spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      T3_CUA_DRIVER: driver,
      T3_CUA_CONTROL: control,
      T3_SERVER_PID: String(process.pid),
      ...driverEnv,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const received: Array<{
    id?: unknown;
    result?: { pid?: number; initialized?: boolean };
    error?: { message: string };
  }> = [];
  const waiters = new Map<unknown, () => void>();
  let buffer = "";
  proxy.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line);
      received.push(message);
      waiters.get(message.id)?.();
    }
  });
  const send = (message: object) => proxy.stdin.write(`${JSON.stringify(message)}\n`);
  const response = (id: number | string) =>
    new Promise<(typeof received)[number]>((resolve) => {
      waiters.set(id, () => resolve(received.find((message) => message.id === id)!));
    });
  const request = async (id: number | string, method: string, params: object) => {
    const answered = response(id);
    send({ jsonrpc: "2.0", id, method, params });
    return answered;
  };
  // The control socket is ready once the proxy has handled its first request.
  yield* Effect.promise(() =>
    request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
  );
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { proxy, control, received, send, response, request };
});

describe("Cua MCP proxy", () => {
  it.effect("ends the session on request and reconnects on the next call", () =>
    Effect.gen(function* () {
      const { proxy, control, received, send, response, request } = yield* startProxy();

      const first = yield* Effect.promise(() =>
        request(2, "tools/call", { name: "whoami", arguments: {} }),
      );
      const stuck = response(3);
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hang" } });

      yield* endCuaSession(control);
      // The call the old driver never answered fails instead of hanging the turn.
      expect((yield* Effect.promise(() => stuck)).error?.message).toContain("Computer use stopped");

      const second = yield* Effect.promise(() =>
        request(4, "tools/call", { name: "whoami", arguments: {} }),
      );
      expect(second.result?.pid).not.toBe(first.result?.pid);
      // The proxy replayed the handshake, and its reply never reached the client.
      expect(second.result?.initialized).toBe(true);
      // A client id that matches the replayed handshake's id still gets its answer.
      const sameId = yield* Effect.promise(() =>
        request("t3-replay-1", "tools/call", { name: "whoami", arguments: {} }),
      );
      expect(sameId.result?.pid).toBe(second.result?.pid);
      expect(received.map((message) => message.id)).toEqual([1, 2, 3, 4, "t3-replay-1"]);

      const exited = new Promise((resolve) => proxy.once("exit", resolve));
      proxy.stdin.end();
      yield* Effect.promise(() => exited);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails queued calls when a new driver refuses the replayed handshake", () =>
    Effect.gen(function* () {
      const { proxy, control, request } = yield* startProxy({ REFUSE_REPLAY: "1" });

      yield* endCuaSession(control);
      const refused = yield* Effect.promise(() =>
        request(2, "tools/call", { name: "whoami", arguments: {} }),
      );
      expect(refused.error?.message).toContain("Computer use stopped");

      const exited = new Promise((resolve) => proxy.once("exit", resolve));
      proxy.stdin.end();
      yield* Effect.promise(() => exited);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
