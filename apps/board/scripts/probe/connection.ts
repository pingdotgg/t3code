import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { WsRpcGroup } from "@t3tools/contracts";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { createEngine } from "../../electron/engine.ts";
import { createLinuxHost, nodeProcessRunner, shellQuote } from "../../electron/wslEngine.ts";
import { describeError, seconds } from "./format.ts";

const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));
const decodeDescriptor = Schema.decodeUnknownSync(Schema.Struct({ serverVersion: Schema.String }));

const makeClient: Effect.Effect<WsRpcProtocolClient, never, Scope.Scope | RpcClient.Protocol> =
  RpcClient.make(WsRpcGroup);

export interface Rpc {
  /** Runs a call against the live socket; one dropped socket is reconnected and the call repeated. */
  readonly run: <A, E>(use: (client: WsRpcProtocolClient) => Effect.Effect<A, E>) => Promise<A>;
  readonly reconnects: () => number;
  readonly close: () => Promise<void>;
}

interface Connection {
  readonly client: WsRpcProtocolClient;
  readonly close: () => Promise<void>;
}

async function openConnection(origin: string, token: string): Promise<Connection> {
  const response = await fetch(`${origin}/api/auth/websocket-ticket/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`websocket-ticket answered ${response.status}`);
  const { ticket } = decodeTicket(await response.json());
  const url = new URL(`${origin.replace(/^http/, "ws")}/ws`);
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const layerProtocol = Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket()).pipe(
    Layer.provide(
      Layer.mergeAll(Socket.layerWebSocket(url.toString()), RpcSerialization.layerJson),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(layerProtocol, scope));
  const client = await Effect.runPromise(
    makeClient.pipe(Effect.provide(context), Scope.provide(scope)),
  );
  return { client, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

const isSocketDrop = (error: Error) => /Socket(Read|Open|Close)Error/.test(describeError(error));

/**
 * Two probe runs lost their socket to a read error mid-run. A call that hits a dropped socket
 * reconnects once and runs again; commands keep their commandId, so the engine dedupes a repeat.
 */
export async function connectRpc(origin: string, token: string): Promise<Rpc> {
  let connection = await openConnection(origin, token);
  let reconnects = 0;
  return {
    run: async (use) => {
      try {
        return await Effect.runPromise(use(connection.client));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!isSocketDrop(failure)) throw error;
        await connection.close().catch(() => undefined);
        connection = await openConnection(origin, token);
        reconnects += 1;
        return Effect.runPromise(use(connection.client));
      }
    },
    reconnects: () => reconnects,
    close: () => connection.close(),
  };
}

export interface ProbeContext {
  readonly rpc: Rpc;
  readonly origin: string;
  readonly runDir: string;
  readonly model: string;
  readonly providerInstance: string;
}

export interface RunningEngine {
  readonly origin: string;
  readonly baseDir: string;
  readonly token: string;
  readonly version: string;
  readonly stop: () => Promise<void>;
}

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const serverBin = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");

const freePort = () => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = NodeNet.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    const { port } = server.address() as NodeNet.AddressInfo;
    server.close(() => resolve(port));
  });
  return promise;
};

export const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  poll: () => Promise<T | null | undefined | false>,
  intervalMs = 1_500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${seconds(timeoutMs)} waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export async function startEngine(runDir: string): Promise<RunningEngine> {
  const baseDir = NodePath.join(runDir, "t3");
  const home = NodeOS.homedir();
  if (
    baseDir === NodePath.join(home, ".t3") ||
    baseDir.startsWith(`${NodePath.join(home, ".t3")}/`)
  ) {
    throw new Error("The probe never runs against ~/.t3.");
  }
  if (!NodeFS.existsSync(serverBin)) {
    throw new Error(`${serverBin} is missing. Run \`vp run --filter t3 build\` first.`);
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = NodeFS.openSync(NodePath.join(runDir, "engine.log"), "a");
  const env = { ...process.env };
  delete env["T3CODE_HOME"];
  delete env["VITE_DEV_SERVER_URL"];
  const child = NodeChildProcess.spawn(
    process.execPath,
    [serverBin, "serve", "--base-dir", baseDir, "--port", String(port), "--no-browser"],
    { stdio: ["ignore", log, log], env },
  );
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  child.once("exit", () => markExited());
  const stop = async () => {
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(20_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    NodeFS.closeSync(log);
  };
  try {
    const version = await waitFor("the engine to answer", 60_000, async () => {
      try {
        const response = await fetch(`${origin}/.well-known/t3/environment`);
        if (!response.ok) return null;
        return decodeDescriptor(await response.json()).serverVersion;
      } catch {
        return null;
      }
    });
    // The board's own engine module mints the token, so the probe proves that path too.
    const host = createLinuxHost({ platform: "linux", distro: null, runner: nodeProcessRunner });
    const engine = createEngine({
      config: {
        engineUrl: origin,
        envToken: undefined,
        t3Home: baseDir,
        t3Cli: `${shellQuote(process.execPath)} ${shellQuote(serverBin)}`,
        distro: undefined,
      },
      host,
      fetch: (url, init) => fetch(url, init),
      tokens: { read: () => null, write: () => undefined },
      runtimeCompatible: () => true,
      confirm: async () => false,
      log: () => undefined,
      sleep,
    });
    await engine.start();
    const token = await engine.token();
    if (!token.ok) throw new Error(`token: ${token.error} ${token.detail}`);
    return { origin, baseDir, token: token.token, version, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Provider children of a stopped engine normally exit with it; this ends any that stayed. */
export function reapLeftovers(runDir: string): void {
  const result = NodeChildProcess.spawnSync("pgrep", ["-f", "--", runDir], { encoding: "utf8" });
  for (const line of result.stdout.split("\n")) {
    const pid = Number(line);
    if (pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}
