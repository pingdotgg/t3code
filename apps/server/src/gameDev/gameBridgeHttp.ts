// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import * as NodeHttp from "node:http";

import type { GameEngineId, GamePlayState } from "@t3tools/contracts";
import { BRIDGE_PROTOCOL_VERSION } from "@t3tools/shared/gameDevCatalog";

import {
  BridgeHelloError,
  type BridgeEvent,
  type BridgeResult,
  type GameBridgeRegistry,
} from "./gameBridgeRegistry.ts";

const MAX_BODY_BYTES = 24 * 1024 * 1024;
const ENGINES: ReadonlySet<string> = new Set(["roblox", "unity", "unreal"]);
const PLAY_STATES: ReadonlySet<string> = new Set(["edit", "playing", "paused", "unknown"]);

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function send(response: NodeHttp.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Body is not JSON."));
      }
    });
    request.on("error", reject);
  });
}

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

function tokenOf(request: NodeHttp.IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  const alternate = request.headers["x-continuum-token"];
  return typeof alternate === "string" ? alternate.trim() : null;
}

/** Routes for editor plugins. Loopback only; every route but /v1/status needs the bridge token. */
export function makeBridgeRequestHandler(registry: GameBridgeRegistry) {
  return async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      send(response, 403, { error: "The Continuum bridge accepts only this computer." });
      return;
    }
    // Browsers reach loopback too; a page must not drive the bridge with the user's editor.
    if (request.headers.origin !== undefined) {
      send(response, 403, { error: "Browser requests are not accepted." });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/status") {
      send(response, 200, { product: "continuum", protocol: BRIDGE_PROTOCOL_VERSION });
      return;
    }
    if (!registry.authenticate(tokenOf(request))) {
      send(response, 401, { error: "The bridge token does not match. Reconnect the project from Continuum." });
      return;
    }
    try {
      if (request.method === "POST" && url.pathname === "/v1/hello") {
        const body = (await readBody(request)) as Record<string, unknown>;
        const engine = str(body.engine);
        if (!ENGINES.has(engine)) return send(response, 400, { error: `Unknown engine ${engine}.` });
        const session = registry.hello({
          protocol: typeof body.protocol === "number" ? body.protocol : 0,
          engine: engine as GameEngineId,
          editorVersion: str(body.editorVersion, "unknown"),
          pluginVersion: str(body.pluginVersion, "unknown"),
          instanceId: str(body.instanceId) || `anonymous-${Date.now()}`,
          projectRoot: typeof body.projectRoot === "string" && body.projectRoot !== "" ? body.projectRoot : null,
          projectName: str(body.projectName, "Untitled"),
          placeKey: typeof body.placeKey === "string" && body.placeKey !== "" ? body.placeKey : null,
          operations: Array.isArray(body.operations) ? body.operations.filter((entry): entry is string => typeof entry === "string") : [],
          playState: PLAY_STATES.has(str(body.playState)) ? (body.playState as GamePlayState) : "unknown",
          inflight: Array.isArray(body.inflight) ? body.inflight.filter((entry): entry is string => typeof entry === "string") : [],
        });
        return send(response, 200, { sessionId: session.sessionId, pollTimeoutMs: 20_000, serverTime: new Date().toISOString() });
      }
      if (request.method === "GET" && url.pathname === "/v1/poll") {
        const pending = registry.poll(url.searchParams.get("session") ?? "");
        if (pending === null) return send(response, 404, { error: "Unknown session; say hello again." });
        let closed = false;
        request.on("close", () => {
          closed = true;
        });
        const commands = await pending;
        if (!closed) send(response, 200, { commands });
        return;
      }
      const body = (await readBody(request)) as Record<string, unknown>;
      const session = str(body.session);
      if (request.method === "POST" && url.pathname === "/v1/results") {
        const results = Array.isArray(body.results) ? (body.results as BridgeResult[]) : [];
        return registry.results(session, results)
          ? send(response, 200, { ok: true })
          : send(response, 404, { error: "Unknown session; say hello again." });
      }
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const events = Array.isArray(body.events) ? (body.events as BridgeEvent[]) : [];
        return registry.events(session, events)
          ? send(response, 200, { ok: true })
          : send(response, 404, { error: "Unknown session; say hello again." });
      }
      if (request.method === "POST" && url.pathname === "/v1/goodbye") {
        registry.goodbye(session);
        return send(response, 200, { ok: true });
      }
      send(response, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof BridgeHelloError) return send(response, error.status, { error: error.message });
      send(response, 400, { error: error instanceof Error ? error.message : "Bad request." });
    }
  };
}

export interface BridgeListener {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export function listenBridge(registry: GameBridgeRegistry, port: number): Promise<BridgeListener> {
  const server = NodeHttp.createServer((request, response) => {
    void makeBridgeRequestHandler(registry)(request, response);
  });
  server.keepAliveTimeout = 30_000;
  server.requestTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
