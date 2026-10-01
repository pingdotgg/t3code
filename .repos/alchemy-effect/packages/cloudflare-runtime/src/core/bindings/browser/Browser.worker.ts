// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local Browser Rendering simulator, adapted from Miniflare's
 * browser-rendering binding worker
 * (`workers-sdk/packages/miniflare/src/workers/browser-rendering/binding.worker.ts`).
 *
 * A single `browser` service hosts the Browser Rendering HTTP surface
 * (`/v1/acquire`, `/v1/sessions`, `/v1/devtools/...`). Each acquired session
 * maps to a real headless Chrome process launched on the Node side through
 * the loopback route (`/browser/launch` etc. — see `Browser.ts`); the
 * `BrowserSession` Durable Object (one instance per session id, in-memory
 * storage) holds the session state and proxies WebSocket/JSON DevTools
 * traffic to Chrome's CDP endpoint.
 *
 * Miniflare routes requests to the Durable Object with its
 * `cf.miniflare.name` extension; here the router uses
 * `env.BrowserSession.getByName(sessionId)` directly and the DO derives the
 * session id from its stored `SessionInfo`.
 */
import { assert, HttpError } from "../../internal/shared.worker.ts";
import type { SessionInfo } from "./BrowserOptions.shared.ts";
import {
  BINDING_BROWSER_LOOPBACK,
  BINDING_BROWSER_SESSION,
} from "./BrowserOptions.shared.ts";

interface Env {
  [BINDING_BROWSER_LOOPBACK]: Fetcher;
  [BINDING_BROWSER_SESSION]: DurableObjectNamespace;
}

function isClosed(ws: WebSocket | undefined): boolean {
  return !ws || ws.readyState === WebSocket.READY_STATE_CLOSED;
}

function chromeBaseUrl(wsEndpoint: string): string {
  const u = new URL(wsEndpoint.replace("ws://", "http://"));
  return `http://${u.host}`;
}

// Substrings of workerd / underlying kj socket error messages that indicate
// a transient connection failure and are safe to retry. Matched
// case-insensitively against `Error.message`.
const RETRYABLE_FETCH_ERROR_SUBSTRINGS = [
  // kj/async-io-win32.c++ ConnectEx (#1225) — the remote socket refused us.
  // Surfaces on Windows when Chrome announced the DevTools URL but isn't
  // quite accepting connections yet.
  "connection refused",
  "remote computer refused",
  // kj/async-io-win32.c++ WSARecv (#64) — the connection went away mid-read.
  "network name is no longer available",
  // Generic workerd disconnect classifications.
  "network connection lost",
  "disconnected",
];

function isRetryableFetchError(error: unknown): boolean {
  const message = (error as { message?: string } | undefined)?.message;
  if (typeof message !== "string") {
    return false;
  }
  const lower = message.toLowerCase();
  return RETRYABLE_FETCH_ERROR_SUBSTRINGS.some((needle) =>
    lower.includes(needle),
  );
}

const MAX_BODY_PREVIEW = 2000;

function truncateBody(text: string): string {
  if (text.length <= MAX_BODY_PREVIEW) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_PREVIEW)}... (truncated, ${text.length} bytes total)`;
}

/**
 * Read a JSON response with diagnostic error reporting. Standard
 * `await resp.json()` produces opaque "Unexpected token X" errors when an
 * upstream returns non-JSON (e.g. an error envelope from the loopback
 * `/browser/launch` handler when Chrome fails to start); this includes the
 * status and (truncated) body text in the thrown error instead.
 */
async function parseJsonResponse<T = unknown>(
  resp: Response,
  context: string,
): Promise<T> {
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `${context}: upstream returned ${resp.status} ${resp.statusText}\n${truncateBody(text)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(
      `${context}: expected JSON, got non-JSON response (${resp.status} ${resp.statusText})\n${truncateBody(text)}`,
      { cause },
    );
  }
}

/**
 * Wrapper around `fetch` that retries on transient connection failures — the
 * first fetches to a freshly-launched Chrome can fail spuriously (especially
 * on Windows) even after the node-side readiness probe succeeded.
 */
async function fetchWithConnectRetry(
  url: string | URL,
  init?: RequestInit,
  {
    maxAttempts = 5,
    baseDelayMs = 25,
    maxDelayMs = 250,
  }: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      if (!isRetryableFetchError(e) || attempt === maxAttempts - 1) {
        break;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Reserved codes 1005 (No Status Received) and 1006 (Abnormal Closure) are
// valid in CloseEvent but throw InvalidAccessError when passed to .close().
function forwardClose(target?: WebSocket, e?: CloseEvent) {
  if (!target || target.readyState === WebSocket.READY_STATE_CLOSED) {
    return;
  }
  if (!e?.code || e?.code === 1005 || e?.code === 1006) {
    target.close();
  } else {
    target.close(e.code, e.reason);
  }
}

export class BrowserSession implements DurableObject {
  sessionInfo?: SessionInfo;
  chromeWs?: WebSocket;
  legacyServerWs?: WebSocket;
  wss: Array<{ chrome: WebSocket; server: WebSocket }> = [];
  #statusTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      // --- Internal routes (called by the module router, not user-facing) ---
      if (req.method === "POST" && path === "/session-info") {
        return await this.#setSessionInfo(req);
      }
      if (req.method === "GET" && path === "/session-info") {
        return this.#getSessionInfo();
      }
      // --- DevTools surface ---
      if (req.method === "GET" && path === "/v1/connectDevtools") {
        return this.#connectDevtools();
      }
      let match: RegExpExecArray | null;
      if (
        req.method === "GET" &&
        (match =
          /^\/v1\/devtools\/browser\/[^/]+\/json\/(version|list|protocol)$/.exec(
            path,
          ))
      ) {
        const chromePath =
          match[1] === "list" ? "/json/list" : `/json/${match[1]}`;
        return await this.#proxyJsonRequest(chromePath);
      }
      if (
        req.method === "GET" &&
        /^\/v1\/devtools\/browser\/[^/]+\/json$/.test(path)
      ) {
        return await this.#proxyJsonRequest("/json/list");
      }
      if (
        req.method === "PUT" &&
        /^\/v1\/devtools\/browser\/[^/]+\/json\/new$/.test(path)
      ) {
        return await this.#proxyJsonRequest(
          `/json/new?${new URLSearchParams({ url: url.searchParams.get("url") ?? "" })}`,
          "PUT",
        );
      }
      if (
        req.method === "GET" &&
        (match =
          /^\/v1\/devtools\/browser\/[^/]+\/json\/(activate|close)\/([^/]+)$/.exec(
            path,
          ))
      ) {
        return await this.#proxyJsonRequest(`/json/${match[1]}/${match[2]}`);
      }
      if (
        req.method === "GET" &&
        (match = /^\/v1\/devtools\/browser\/[^/]+\/page\/([^/]+)$/.exec(path))
      ) {
        if (!this.sessionInfo) {
          return Response.json({ error: "Browser not found" }, { status: 404 });
        }
        return await this.#proxyRawWebSocket(
          `${chromeBaseUrl(this.sessionInfo.wsEndpoint).replace("http://", "ws://")}/devtools/page/${match[1]}`,
        );
      }
      if (
        req.method === "DELETE" &&
        /^\/v1\/devtools\/browser\/[^/]+$/.test(path)
      ) {
        return this.#closeBrowser();
      }
      if (
        req.method === "GET" &&
        /^\/v1\/devtools\/session\/[^/]+$/.test(path)
      ) {
        return this.#sessionDetail();
      }
      if (
        req.method === "GET" &&
        /^\/v1\/devtools\/browser\/[^/]+$/.test(path)
      ) {
        return await this.#connect();
      }
      return new Response("Not Found", { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) {
        return e.toResponse();
      }
      throw e;
    }
  }

  /**
   * Store the launched session and establish a persistent WebSocket to
   * Chrome's DevTools endpoint. This serves as the health indicator for the
   * session and is reused by the legacy chunked-framing client
   * (`/v1/connectDevtools`).
   */
  async #setSessionInfo(req: Request): Promise<Response> {
    this.sessionInfo = await req.json();
    const wsUrl = this.sessionInfo!.wsEndpoint.replace("ws://", "http://");
    const resp = await fetchWithConnectRetry(wsUrl, {
      headers: { Upgrade: "websocket" },
    });
    assert(resp.webSocket !== null, "Expected a WebSocket response");
    this.chromeWs = resp.webSocket;
    this.chromeWs.accept();
    // Forward Chrome messages to whatever legacyServerWs is currently
    // connected. Set up once here so reconnects don't accumulate duplicate
    // listeners.
    this.chromeWs.addEventListener("message", (m) => {
      if (!this.legacyServerWs) {
        return;
      }
      const string = new TextEncoder().encode(m.data as string);
      const data = new Uint8Array(string.length + 4);
      const view = new DataView(data.buffer);
      view.setUint32(0, string.length, true);
      data.set(string, 4);
      this.legacyServerWs.send(data);
    });
    this.chromeWs.addEventListener("close", (e) => {
      this.closeSession(e);
    });
    this.#scheduleStatusCheck();
    return new Response(null, { status: 204 });
  }

  #getSessionInfo(): Response {
    if (isClosed(this.chromeWs)) {
      this.closeSession();
    }
    if (!this.sessionInfo) {
      return new Response(null, { status: 204 });
    }
    return Response.json(this.sessionInfo);
  }

  /** Legacy chunked-framing DevTools connection (`@cloudflare/puppeteer`). */
  #connectDevtools(): Response {
    assert(
      this.sessionInfo !== undefined,
      "sessionInfo must be set before connecting",
    );
    assert(
      this.chromeWs !== undefined,
      "chromeWs must be established before connecting",
    );
    if (this.legacyServerWs !== undefined) {
      throw new HttpError(409, "WebSocket already initialized");
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    server.addEventListener("message", (m) => {
      if (m.data === "ping") {
        return;
      }
      this.chromeWs?.send(
        new TextDecoder().decode((m.data as ArrayBuffer).slice(4)),
      );
    });
    server.addEventListener("close", (e) => {
      this.closeWebSockets(e);
    });
    this.legacyServerWs = server;
    this.sessionInfo.connectionId = crypto.randomUUID();
    this.sessionInfo.connectionStartTime = Date.now();

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "cf-browser-session-id": this.sessionInfo.sessionId },
    });
  }

  /** Raw (unchunked) WebSocket connection to Chrome's browser endpoint. */
  async #connect(): Promise<Response> {
    assert(
      this.sessionInfo !== undefined,
      "sessionInfo must be set before connecting",
    );

    const wsUrl = this.sessionInfo.wsEndpoint.replace("ws://", "http://");
    const resp = await this.#proxyRawWebSocket(wsUrl);

    this.sessionInfo.connectionId = crypto.randomUUID();
    this.sessionInfo.connectionStartTime = Date.now();

    return new Response(null, {
      status: resp.status,
      webSocket: resp.webSocket,
      headers: { "cf-browser-session-id": this.sessionInfo.sessionId },
    });
  }

  #closeBrowser(): Response {
    // Browser.close CDP doesn't reliably kill Chrome, so we kill via the
    // loopback instead. The DO returns immediately so it stays idle while
    // the module router waits for Chrome to fully exit.
    if (this.sessionInfo) {
      const closeUrl = new URL("http://localhost/browser/close");
      closeUrl.searchParams.set("sessionId", this.sessionInfo.sessionId);
      this.state.waitUntil(
        this.env[BINDING_BROWSER_LOOPBACK]
          .fetch(closeUrl, { method: "POST" })
          .then(
            () => {},
            () => {},
          ),
      );
    }
    return Response.json({ status: "closed" });
  }

  #sessionDetail(): Response {
    if (!this.sessionInfo) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    return Response.json({
      sessionId: this.sessionInfo.sessionId,
      startTime: this.sessionInfo.startTime,
      connectionId: this.sessionInfo.connectionId,
      connectionStartTime: this.sessionInfo.connectionStartTime,
    });
  }

  closeWebSockets(e?: CloseEvent) {
    forwardClose(this.legacyServerWs, e);
    for (const { chrome, server } of this.wss) {
      forwardClose(chrome, e);
      forwardClose(server, e);
    }
    this.legacyServerWs = undefined;
    this.wss = [];
    if (this.sessionInfo) {
      this.sessionInfo.connectionId = undefined;
      this.sessionInfo.connectionStartTime = undefined;
    }
  }

  closeSession(e?: CloseEvent) {
    if (this.#statusTimeout !== undefined) {
      clearTimeout(this.#statusTimeout);
      this.#statusTimeout = undefined;
    }
    this.closeWebSockets(e);
    forwardClose(this.chromeWs, e);
    this.chromeWs = undefined;
    this.sessionInfo = undefined;
  }

  async #proxyRawWebSocket(targetWsUrl: string): Promise<Response> {
    const response = await fetchWithConnectRetry(
      targetWsUrl.replace("ws://", "http://"),
      {
        headers: { Upgrade: "websocket" },
      },
    );

    assert(response.webSocket !== null, "Expected a WebSocket response");
    const chrome = response.webSocket;
    chrome.accept();

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    const pair = { chrome, server };
    this.wss.push(pair);

    chrome.addEventListener("message", (m) => server.send(m.data as string));
    server.addEventListener("message", (m) => chrome.send(m.data as string));
    server.addEventListener("close", (e) => {
      forwardClose(chrome, e);
      forwardClose(server, e);
      this.wss = this.wss.filter((p) => p !== pair);
    });
    chrome.addEventListener("close", (e) => {
      forwardClose(server, e);
      forwardClose(chrome, e);
      this.wss = this.wss.filter((p) => p !== pair);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async #proxyJsonRequest(
    chromePath: string,
    method = "GET",
  ): Promise<Response> {
    if (!this.sessionInfo) {
      return Response.json({ error: "Browser not found" }, { status: 404 });
    }
    const resp = await fetchWithConnectRetry(
      `${chromeBaseUrl(this.sessionInfo.wsEndpoint)}${chromePath}`,
      { method },
    );
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async #checkStatus() {
    if (this.sessionInfo) {
      const url = new URL("http://localhost/browser/status");
      url.searchParams.set("sessionId", this.sessionInfo.sessionId);
      const resp = await this.env[BINDING_BROWSER_LOOPBACK].fetch(url);
      if (!resp.ok) {
        this.closeSession();
      }
    }
  }

  #scheduleStatusCheck() {
    if (this.#statusTimeout !== undefined) {
      return;
    }
    this.#statusTimeout = setTimeout(async () => {
      this.#statusTimeout = undefined;
      await this.#checkStatus();
      if (this.chromeWs) {
        this.#scheduleStatusCheck();
      }
    }, 1000);
  }
}

// -----------------------------------------------------------------------------
// Module router (`BrowserRenderingRouter` upstream)
// -----------------------------------------------------------------------------

class BrowserRenderingRouter {
  constructor(private readonly env: Env) {}

  #callSession(sessionId: string, request: Request): Promise<Response> {
    const stub = this.env[BINDING_BROWSER_SESSION].getByName(sessionId);
    return stub.fetch(request);
  }

  #fetchSession(
    sessionId: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const stub = this.env[BINDING_BROWSER_SESSION].getByName(sessionId);
    return stub.fetch(`http://placeholder${path}`, init);
  }

  async #acquireSession(): Promise<SessionInfo> {
    const resp = await this.env[BINDING_BROWSER_LOOPBACK].fetch(
      "http://localhost/browser/launch",
    );
    const sessionInfo = await parseJsonResponse<SessionInfo>(
      resp,
      "Failed to launch local browser via the loopback (/browser/launch)",
    );
    await this.#fetchSession(sessionInfo.sessionId, "/session-info", {
      method: "POST",
      body: JSON.stringify(sessionInfo),
    });
    return sessionInfo;
  }

  async #getActiveSessions() {
    const sessionIdsResp = await this.env[BINDING_BROWSER_LOOPBACK].fetch(
      "http://localhost/browser/sessionIds",
    );
    const sessionIds = await parseJsonResponse<Array<string>>(
      sessionIdsResp,
      "Failed to list active browser sessions via the loopback (/browser/sessionIds)",
    );

    const sessions = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const resp = await this.#fetchSession(sessionId, "/session-info");
        if (resp.status === 204) {
          return null;
        }
        const sessionInfo = await parseJsonResponse<SessionInfo>(
          resp,
          `Failed to read session-info for browser session ${sessionId}`,
        );
        return {
          sessionId: sessionInfo.sessionId,
          startTime: sessionInfo.startTime,
          connectionId: sessionInfo.connectionId,
          connectionStartTime: sessionInfo.connectionStartTime,
        };
      }),
    );

    return sessions.filter(Boolean);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/v1/acquire") {
      const sessionInfo = await this.#acquireSession();
      return Response.json({ sessionId: sessionInfo.sessionId });
    }
    if (req.method === "GET" && path === "/v1/sessions") {
      return Response.json({ sessions: await this.#getActiveSessions() });
    }
    if (req.method === "GET" && path === "/v1/limits") {
      return Response.json({
        maxConcurrentSessions: 6,
        allowedBrowserAcquisitions: 6,
        timeUntilNextAllowedBrowserAcquisition: 0,
      });
    }
    if (req.method === "GET" && path === "/v1/history") {
      return Response.json([]);
    }
    if (req.method === "GET" && path === "/v1/devtools/session") {
      return Response.json(await this.#getActiveSessions());
    }
    if (req.method === "GET" && path === "/v1/connectDevtools") {
      const sessionId = url.searchParams.get("browser_session");
      if (!sessionId) {
        return new Response("browser_session must be set", { status: 400 });
      }
      return this.#callSession(sessionId, req);
    }
    if (req.method === "POST" && path === "/v1/devtools/browser") {
      const sessionInfo = await this.#acquireSession();
      return Response.json({ sessionId: sessionInfo.sessionId });
    }
    if (req.method === "GET" && path === "/v1/devtools/browser") {
      // Acquire a session and connect to it in one request.
      const sessionInfo = await this.#acquireSession();
      const doUrl = new URL(req.url);
      doUrl.pathname = `/v1/devtools/browser/${sessionInfo.sessionId}`;
      return this.#callSession(
        sessionInfo.sessionId,
        new Request(doUrl, {
          method: req.method,
          headers: {
            ...Object.fromEntries(req.headers),
            "x-session-id": sessionInfo.sessionId,
          },
        }),
      );
    }
    let match: RegExpExecArray | null;
    if (
      req.method === "GET" &&
      (match = /^\/v1\/devtools\/session\/([^/]+)$/.exec(path))
    ) {
      return this.#callSession(match[1], req);
    }
    if (
      req.method === "DELETE" &&
      (match = /^\/v1\/devtools\/browser\/([^/]+)$/.exec(path))
    ) {
      const sessionId = match[1];
      // The DO sends the kill signal and returns immediately, keeping it
      // idle so WebSocket close events can propagate to the user.
      const resp = await this.#callSession(sessionId, req);
      if (!resp.ok) {
        return resp;
      }
      // Poll until Chrome has exited so the session list is clean.
      for (let i = 0; i < 50; i++) {
        const statusUrl = new URL("http://localhost/browser/status");
        statusUrl.searchParams.set("sessionId", sessionId);
        const statusResp =
          await this.env[BINDING_BROWSER_LOOPBACK].fetch(statusUrl);
        if (statusResp.status === 410) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return Response.json({ status: "closed" });
    }
    // All remaining `/v1/devtools/browser/:sessionId...` routes (raw connect,
    // json/*, page/*) are handled by the session's Durable Object.
    if (
      (req.method === "GET" || req.method === "PUT") &&
      (match = /^\/v1\/devtools\/browser\/([^/]+)(\/.*)?$/.exec(path))
    ) {
      return this.#callSession(match[1], req);
    }
    return new Response("Not Found", { status: 404 });
  }
}

export default {
  fetch(request, env) {
    return new BrowserRenderingRouter(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
