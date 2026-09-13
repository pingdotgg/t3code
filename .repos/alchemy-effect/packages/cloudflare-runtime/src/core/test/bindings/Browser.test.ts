// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's browser-rendering plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/browser/index.spec.ts`).
 *
 * Every upstream case is ported. Deltas from upstream:
 * - Upstream's "two workers with different browser bindings can coexist"
 *   binds two browser bindings and asserts both work; here both bindings sit
 *   on one worker (the shared `browser` service is deduplicated either way).
 * - Upstream mutes its CLI download spinner; this runtime logs download
 *   progress to stderr, so there is nothing to mute.
 * - Scenarios that leave a browser session running explicitly DELETE it at
 *   the end (upstream disposes the whole Miniflare instance per test; here
 *   one runtime layer is shared across the file, and stray Chrome processes
 *   are only reaped by the layer finalizer at suite end).
 *
 * The first Chrome launch may download the pinned build (~150 MB) into the
 * shared wrangler cache; the first test gets a generous timeout to cover it.
 */
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Browser from "../../bindings/browser/index.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

// -----------------------------------------------------------------------------
// Test worker: one route per upstream scenario, driving `env.MYBROWSER`.
// Written without template literals so it can be embedded in this file's
// template literal without escaping.
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
// adapted from https://github.com/cloudflare/puppeteer/blob/b4984452165437e26dd1c8e516581cec2a02b4cd/packages/puppeteer-core/src/cloudflare/chunking.ts#L6-L30
function messageToChunks(data) {
  const HEADER_SIZE = 4; // Uint32
  const MAX_MESSAGE_SIZE = 1048575; // Workers size is < 1MB
  const FIRST_CHUNK_DATA_SIZE = MAX_MESSAGE_SIZE - HEADER_SIZE;

  const encoder = new TextEncoder();
  const encodedUint8Array = encoder.encode(data);

  // We only include the header into the first chunk
  const firstChunk = new Uint8Array(
    Math.min(MAX_MESSAGE_SIZE, HEADER_SIZE + encodedUint8Array.length),
  );
  const view = new DataView(firstChunk.buffer);
  view.setUint32(0, encodedUint8Array.length, true);
  firstChunk.set(encodedUint8Array.slice(0, FIRST_CHUNK_DATA_SIZE), HEADER_SIZE);

  const chunks = [firstChunk];
  for (let i = FIRST_CHUNK_DATA_SIZE; i < data.length; i += MAX_MESSAGE_SIZE) {
    chunks.push(encodedUint8Array.slice(i, i + MAX_MESSAGE_SIZE));
  }
  return chunks;
}

function sendMessage(ws, message) {
  for (const chunk of messageToChunks(JSON.stringify(message))) {
    ws.send(chunk);
  }
}

async function waitForClosedConnection(ws) {
  if (ws.readyState === WebSocket.READY_STATE_CLOSED) {
    return;
  }
  await new Promise((resolve) => {
    ws.addEventListener("close", () => {
      if (ws.readyState !== WebSocket.READY_STATE_CLOSED) {
        ws.close();
      }
      resolve();
    });
  });
}

// Reassemble a chunked (4-byte little-endian length header) DevTools message.
async function waitForMessage(ws) {
  const chunks = [];
  return new Promise((resolve) => {
    ws.addEventListener("message", function handler(event) {
      const data = new Uint8Array(event.data);
      if (chunks.length === 0) {
        const view = new DataView(data.buffer);
        const totalLength = view.getUint32(0, true);
        chunks.push({ data: data.slice(4), totalLength });
      } else {
        chunks[0].data = new Uint8Array([...chunks[0].data, ...data]);
      }
      const accumulated = chunks[0];
      if (accumulated.data.length >= accumulated.totalLength) {
        ws.removeEventListener("message", handler);
        const text = new TextDecoder().decode(
          accumulated.data.slice(0, accumulated.totalLength),
        );
        resolve(JSON.parse(text));
      }
    });
  });
}

async function acquire(browser) {
  const res = await browser.fetch("https://localhost/v1/acquire");
  return await res.json();
}

async function connectDevtools(browser, sessionId) {
  const res = await browser.fetch(
    "https://localhost/v1/connectDevtools?browser_session=" + sessionId,
    { headers: { Upgrade: "websocket" } },
  );
  return res;
}

async function closeSession(browser, sessionId) {
  await browser.fetch("https://localhost/v1/devtools/browser/" + sessionId, {
    method: "DELETE",
  });
}

const routes = {
  // "it creates a browser session"
  "/session": async (env) => {
    const newBrowserSession = await env.MYBROWSER.fetch("https://localhost/v1/acquire");
    const text = await newBrowserSession.text();
    const { sessionId } = JSON.parse(text);
    await closeSession(env.MYBROWSER, sessionId);
    return new Response(text);
  },

  // "two browser bindings can coexist"
  "/two-bindings": async (env) => {
    const a = await acquire(env.BROWSER_A);
    const b = await acquire(env.BROWSER_B);
    await closeSession(env.BROWSER_A, a.sessionId);
    await closeSession(env.BROWSER_B, b.sessionId);
    return Response.json({ a, b });
  },

  // "it closes a browser session"
  "/close": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const { webSocket: ws } = await connectDevtools(env.MYBROWSER, sessionId);
    ws.accept();

    sendMessage(ws, { method: "Browser.close", id: -1 });
    await waitForClosedConnection(ws);

    return new Response("Browser closed");
  },

  // "it reuses a browser session"
  "/reuse": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const { webSocket: ws } = await connectDevtools(env.MYBROWSER, sessionId);
    ws.accept();
    ws.close();

    await waitForClosedConnection(ws);

    // Reuse the same session by connecting to it again
    const { webSocket: ws2 } = await connectDevtools(env.MYBROWSER, sessionId);
    ws2.accept();
    ws2.close();

    await closeSession(env.MYBROWSER, sessionId);
    return new Response("Browser session reused");
  },

  // "it reconnects and sends CDP commands after disconnect"
  "/reconnect": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);

    // First connection
    const { webSocket: ws } = await connectDevtools(env.MYBROWSER, sessionId);
    ws.accept();

    // Send a CDP command and verify we get a response
    const msg1Promise = waitForMessage(ws);
    sendMessage(ws, { method: "Target.getTargets", id: 1 });
    const msg1 = await msg1Promise;
    if (!msg1 || !msg1.result) {
      return new Response("First CDP command failed: " + JSON.stringify(msg1));
    }

    // Disconnect
    ws.close();
    await waitForClosedConnection(ws);

    // Reconnect with the same sessionId
    const resp2 = await connectDevtools(env.MYBROWSER, sessionId);
    if (!resp2.webSocket) {
      return new Response("Reconnect failed with status: " + resp2.status);
    }
    const ws2 = resp2.webSocket;
    ws2.accept();

    // Send a CDP command on the reconnected socket
    const msg2Promise = waitForMessage(ws2);
    sendMessage(ws2, { method: "Target.getTargets", id: 2 });
    const msg2 = await msg2Promise;
    if (!msg2 || !msg2.result) {
      return new Response("Second CDP command failed: " + JSON.stringify(msg2));
    }

    ws2.close();
    await closeSession(env.MYBROWSER, sessionId);
    return new Response("Reconnect successful");
  },

  // "fails if browser session already in use"
  "/already-used": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const { webSocket: ws } = await connectDevtools(env.MYBROWSER, sessionId);
    ws.accept();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // try to open new connection for the same session
    const resp2 = await connectDevtools(env.MYBROWSER, sessionId);
    const status = resp2.status;
    await closeSession(env.MYBROWSER, sessionId);
    if (status === 409) {
      return new Response("Failed to connect to browser session");
    }

    return new Response("Should not reach here");
  },

  // "gets sessions while acquiring and closing session"
  "/sessions-lifecycle": async (env) => {
    const { sessions: emptySessions } = await env.MYBROWSER.fetch(
      "https://localhost/v1/sessions",
    ).then((res) => res.json());
    const { sessionId } = await acquire(env.MYBROWSER);
    const { sessions: acquiredSessions } = await env.MYBROWSER.fetch(
      "https://localhost/v1/sessions",
    ).then((res) => res.json());

    const { webSocket: ws } = await connectDevtools(env.MYBROWSER, sessionId);
    ws.accept();

    // send a close message to the browser
    sendMessage(ws, { method: "Browser.close", id: -1 });

    await waitForClosedConnection(ws);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const { sessions: afterClosedSessions } = await env.MYBROWSER.fetch(
      "https://localhost/v1/sessions",
    ).then((res) => res.json());

    return Response.json({ emptySessions, acquiredSessions, afterClosedSessions });
  },

  // "gets sessions while connecting and disconnecting session"
  "/sessions-disconnect": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const { webSocket: ws } = await connectDevtools(env.MYBROWSER, sessionId);
    ws.accept();

    const {
      sessions: [connectedSession],
    } = await env.MYBROWSER.fetch("https://localhost/v1/sessions").then((res) => res.json());
    ws.close();

    await waitForClosedConnection(ws);

    const {
      sessions: [disconnectedSession],
    } = await env.MYBROWSER.fetch("https://localhost/v1/sessions").then((res) => res.json());

    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({ connectedSession, disconnectedSession });
  },

  // "returns limits"
  "/limits": (env) => env.MYBROWSER.fetch("https://localhost/v1/limits"),

  // "returns empty history"
  "/history": (env) => env.MYBROWSER.fetch("https://localhost/v1/history"),

  // "devtools session list and detail endpoints"
  "/devtools-session": async (env) => {
    const emptyList = await env.MYBROWSER.fetch("https://localhost/v1/devtools/session").then(
      (r) => r.json(),
    );
    const { sessionId } = await acquire(env.MYBROWSER);
    const list = await env.MYBROWSER.fetch("https://localhost/v1/devtools/session").then((r) =>
      r.json(),
    );
    const detail = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/session/" + sessionId,
    ).then((r) => r.json());
    const missing = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/session/does-not-exist",
    );
    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({ emptyList, list, detail, missingStatus: missing.status });
  },

  // "devtools json/version, json/list, json endpoints"
  "/devtools-json": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const base = "https://localhost/v1/devtools/browser/" + sessionId;

    const version = await env.MYBROWSER.fetch(base + "/json/version").then((r) => r.json());
    const list = await env.MYBROWSER.fetch(base + "/json/list").then((r) => r.json());
    const listAlias = await env.MYBROWSER.fetch(base + "/json").then((r) => r.json());

    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({ version, list, listAlias });
  },

  // "DELETE /v1/devtools/browser/:session_id closes browser"
  "/devtools-delete": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const { webSocket: ws } = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/browser/" + sessionId,
      { headers: { Upgrade: "websocket" } },
    );
    ws.accept();
    const deleteResp = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/browser/" + sessionId,
      { method: "DELETE" },
    );
    const deleteBody = await deleteResp.json();
    // Verify the session is gone after DELETE
    const { sessions } = await env.MYBROWSER.fetch(
      "https://localhost/v1/sessions?sessionId=" + sessionId,
    ).then((r) => r.json());
    const sessionGone = sessions.length === 0;
    await waitForClosedConnection(ws);
    const wsClosed = ws.readyState === WebSocket.READY_STATE_CLOSED;
    return Response.json({
      deleteStatus: deleteResp.status,
      deleteBody,
      sessionGone,
      wsClosed,
    });
  },

  // "POST /v1/devtools/browser acquires session, GET /v1/devtools/browser/:id
  // connects and returns cf-browser-session-id"
  "/devtools-browser-ws": async (env) => {
    const postResp = await env.MYBROWSER.fetch("https://localhost/v1/devtools/browser", {
      method: "POST",
    });
    const { sessionId } = await postResp.json();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const getResp = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/browser/" + sessionId,
      { headers: { Upgrade: "websocket" } },
    );
    const sessionIdFromGet = getResp.headers.get("cf-browser-session-id");
    const ws = getResp.webSocket;
    ws.accept();
    const browserVersion = await new Promise((resolve) => {
      ws.addEventListener("message", (m) => resolve(JSON.parse(m.data)));
      ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    ws.close();

    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({
      postStatus: postResp.status,
      sessionId,
      getStatus: getResp.status,
      sessionIdFromGet,
      browserProduct: browserVersion.result?.product,
    });
  },

  // "GET /v1/devtools/browser acquires and connects"
  "/devtools-browser-get": async (env) => {
    const resp = await env.MYBROWSER.fetch("https://localhost/v1/devtools/browser", {
      headers: { Upgrade: "websocket" },
    });
    const sessionId = resp.headers.get("cf-browser-session-id");
    const ws = resp.webSocket;
    ws.accept();
    const browserVersion = await new Promise((resolve) => {
      ws.addEventListener("message", (m) => resolve(JSON.parse(m.data)));
      ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    ws.close();
    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({
      status: resp.status,
      sessionId,
      browserProduct: browserVersion.result?.product,
    });
  },

  // "devtools json/protocol endpoint"
  "/json-protocol": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const protocol = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/browser/" + sessionId + "/json/protocol",
    ).then((r) => r.json());
    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({ hasDomains: Array.isArray(protocol.domains) });
  },

  // "devtools json/new, json/activate, json/close endpoints"
  "/json-new-activate-close": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const base = "https://localhost/v1/devtools/browser/" + sessionId;
    const newTarget = await env.MYBROWSER.fetch(base + "/json/new?url=about:blank", {
      method: "PUT",
    }).then((r) => r.json());
    const activateResp = await env.MYBROWSER.fetch(base + "/json/activate/" + newTarget.id);
    const closeResp = await env.MYBROWSER.fetch(base + "/json/close/" + newTarget.id);
    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({
      targetType: newTarget.type,
      activateStatus: activateResp.status,
      closeStatus: closeResp.status,
    });
  },

  // "devtools page/:target_id WebSocket endpoint"
  "/page-ws": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const base = "https://localhost/v1/devtools/browser/" + sessionId;
    const targets = await env.MYBROWSER.fetch(base + "/json/list").then((r) => r.json());
    const targetId = targets[0].id;
    const { webSocket: ws } = await env.MYBROWSER.fetch(base + "/page/" + targetId, {
      headers: { Upgrade: "websocket" },
    });
    ws.accept();
    const result = await new Promise((resolve) => {
      ws.addEventListener("message", (m) => resolve(JSON.parse(m.data)));
      ws.send(
        JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1+1" } }),
      );
    });
    ws.close();
    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({ resultValue: result.result?.result?.value });
  },

  // "DELETE without prior WebSocket connection"
  "/delete-no-ws": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const deleteResp = await env.MYBROWSER.fetch(
      "https://localhost/v1/devtools/browser/" + sessionId,
      { method: "DELETE" },
    );
    const deleteBody = await deleteResp.json();
    const { sessions } = await env.MYBROWSER.fetch("https://localhost/v1/sessions").then((r) =>
      r.json(),
    );
    return Response.json({
      deleteStatus: deleteResp.status,
      deleteBody,
      sessionGone: sessions.length === 0,
    });
  },

  // "DELETE closes all WebSocket connections (browser + page)"
  "/delete-all-ws": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const base = "https://localhost/v1/devtools/browser/" + sessionId;

    // Connect browser-level WebSocket
    const { webSocket: browserWs } = await env.MYBROWSER.fetch(base, {
      headers: { Upgrade: "websocket" },
    });
    browserWs.accept();

    // Connect page-level WebSocket
    const targets = await env.MYBROWSER.fetch(base + "/json/list").then((r) => r.json());
    const { webSocket: pageWs } = await env.MYBROWSER.fetch(base + "/page/" + targets[0].id, {
      headers: { Upgrade: "websocket" },
    });
    pageWs.accept();

    // DELETE should close everything
    const deleteResp = await env.MYBROWSER.fetch(base, { method: "DELETE" });
    const deleteBody = await deleteResp.json();

    await Promise.all([waitForClosedConnection(browserWs), waitForClosedConnection(pageWs)]);

    return Response.json({
      deleteStatus: deleteResp.status,
      deleteBody,
      browserWsClosed: browserWs.readyState === WebSocket.READY_STATE_CLOSED,
      pageWsClosed: pageWs.readyState === WebSocket.READY_STATE_CLOSED,
    });
  },

  // "multiple concurrent raw WebSocket connections to same session"
  "/multi-ws": async (env) => {
    const { sessionId } = await acquire(env.MYBROWSER);
    const base = "https://localhost/v1/devtools/browser/" + sessionId;

    // Open two raw WebSocket connections to the same browser session
    const { webSocket: ws1 } = await env.MYBROWSER.fetch(base, {
      headers: { Upgrade: "websocket" },
    });
    ws1.accept();

    const { webSocket: ws2 } = await env.MYBROWSER.fetch(base, {
      headers: { Upgrade: "websocket" },
    });
    ws2.accept();

    // Send Browser.getVersion on both and verify responses
    const v1 = new Promise((resolve) => {
      ws1.addEventListener("message", (m) => resolve(JSON.parse(m.data)));
      ws1.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    const v2 = new Promise((resolve) => {
      ws2.addEventListener("message", (m) => resolve(JSON.parse(m.data)));
      ws2.send(JSON.stringify({ id: 2, method: "Browser.getVersion" }));
    });

    const [r1, r2] = await Promise.all([v1, v2]);
    ws1.close();
    ws2.close();

    await closeSession(env.MYBROWSER, sessionId);
    return Response.json({
      product1: r1.result?.product,
      product2: r2.result?.product,
    });
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = routes[url.pathname];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    try {
      return await route(env);
    } catch (e) {
      return new Response("Test worker error: " + (e?.stack ?? String(e)), { status: 500 });
    }
  },
};
`;

const startBrowserTestWorker = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate: "2024-11-20",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [
      Browser.local({ binding: "MYBROWSER" }),
      Browser.local({ binding: "BROWSER_A" }),
      Browser.local({ binding: "BROWSER_B" }),
    ],
  });

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Browser Rendering binding",
  (it) => {
    // This suite previously destabilized the Windows CI runner (run
    // 30741543083): orphaned Chrome process trees survived per-test teardown
    // and starved the 4-core runner until every subsequent vitest fork failed
    // its 60s start handshake. Root cause: puppeteer's `Process.close()` falls
    // back to a single-pid `ChildProcess.kill()` when its `taskkill /T` throws
    // (leaving Chrome's child processes orphaned on Windows), and failed
    // launches (`waitForLineOutput`/readiness-probe errors) never killed the
    // spawned Chrome at all. `closeBrowserProcess` in `Browser.ts` now
    // tree-kills on every teardown path, so the suite runs on Windows CI again.
    const test = it.effect;

    test(
      "it creates a browser session",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-session");
          const text = yield* worker.fetchText("/session");
          expect(text.includes("sessionId")).toBe(true);
        }),
      // The first launch may download Chrome into the shared wrangler cache.
      { timeout: 120_000 },
    );

    test(
      "two browser bindings can coexist",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-two-bindings");
          const { a, b } = yield* worker.fetchJson<{
            a: { sessionId: string };
            b: { sessionId: string };
          }>("/two-bindings");
          expect(typeof a.sessionId).toBe("string");
          expect(typeof b.sessionId).toBe("string");
          expect(a.sessionId).not.toBe(b.sessionId);
        }),
      { timeout: 60_000 },
    );

    test(
      "it closes a browser session",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-close");
          expect(yield* worker.fetchText("/close")).toBe("Browser closed");
        }),
      { timeout: 60_000 },
    );

    test(
      "it reuses a browser session",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-reuse");
          expect(yield* worker.fetchText("/reuse")).toBe(
            "Browser session reused",
          );
        }),
      { timeout: 60_000 },
    );

    test(
      "it reconnects and sends CDP commands after disconnect",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-reconnect");
          expect(yield* worker.fetchText("/reconnect")).toBe(
            "Reconnect successful",
          );
        }),
      { timeout: 60_000 },
    );

    test(
      "fails if browser session already in use",
      () =>
        Effect.gen(function* () {
          if (process.platform === "win32") return; // matches upstream skip
          const worker = yield* startBrowserTestWorker("browser-already-used");
          expect(yield* worker.fetchText("/already-used")).toBe(
            "Failed to connect to browser session",
          );
        }),
      { timeout: 60_000 },
    );

    test(
      "gets sessions while acquiring and closing session",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker(
            "browser-sessions-lifecycle",
          );
          const { emptySessions, acquiredSessions, afterClosedSessions } =
            yield* worker.fetchJson<{
              emptySessions: Array<unknown>;
              acquiredSessions: Array<{
                sessionId: unknown;
                startTime: unknown;
                connectionId?: unknown;
              }>;
              afterClosedSessions: Array<unknown>;
            }>("/sessions-lifecycle");
          expect(emptySessions.length).toBe(0);
          expect(acquiredSessions.length).toBe(1);
          expect(
            typeof acquiredSessions[0].sessionId === "string" &&
              typeof acquiredSessions[0].startTime === "number" &&
              !acquiredSessions[0].connectionId,
          ).toBe(true);
          expect(afterClosedSessions.length).toBe(0);
        }),
      { timeout: 60_000 },
    );

    test(
      "gets sessions while connecting and disconnecting session",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker(
            "browser-sessions-disconnect",
          );
          const { connectedSession, disconnectedSession } =
            yield* worker.fetchJson<{
              connectedSession: {
                sessionId: string;
                connectionId?: string;
                connectionStartTime?: number;
              };
              disconnectedSession: {
                sessionId: string;
                connectionId?: string;
                connectionStartTime?: number;
              };
            }>("/sessions-disconnect");
          expect(connectedSession.sessionId).toBe(
            disconnectedSession.sessionId,
          );
          expect(
            typeof connectedSession.connectionId === "string" &&
              typeof connectedSession.connectionStartTime === "number",
          ).toBe(true);
          expect(
            !disconnectedSession.connectionId &&
              !disconnectedSession.connectionStartTime,
          ).toBe(true);
        }),
      { timeout: 60_000 },
    );

    test("returns limits", () =>
      Effect.gen(function* () {
        const worker = yield* startBrowserTestWorker("browser-limits");
        const res = yield* worker.fetch("/limits");
        expect(res.status).toBe(200);
        const body = (yield* Effect.promise(() => res.json())) as {
          maxConcurrentSessions: unknown;
          allowedBrowserAcquisitions: unknown;
          timeUntilNextAllowedBrowserAcquisition: unknown;
        };
        expect(typeof body.maxConcurrentSessions).toBe("number");
        expect(typeof body.allowedBrowserAcquisitions).toBe("number");
        expect(typeof body.timeUntilNextAllowedBrowserAcquisition).toBe(
          "number",
        );
      }));

    test("returns empty history", () =>
      Effect.gen(function* () {
        const worker = yield* startBrowserTestWorker("browser-history");
        const res = yield* worker.fetch("/history");
        expect(res.status).toBe(200);
        expect(yield* Effect.promise(() => res.json())).toEqual([]);
      }));

    test(
      "devtools session list and detail endpoints",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker(
            "browser-devtools-session",
          );
          const { emptyList, list, detail, missingStatus } =
            yield* worker.fetchJson<{
              emptyList: Array<unknown>;
              list: Array<{ sessionId: string }>;
              detail: { sessionId: string };
              missingStatus: number;
            }>("/devtools-session");
          expect(emptyList).toEqual([]);
          expect(list.length).toBe(1);
          expect(typeof list[0].sessionId).toBe("string");
          expect(detail.sessionId).toBe(list[0].sessionId);
          expect(missingStatus).toBe(404);
        }),
      { timeout: 60_000 },
    );

    test(
      "devtools json/version, json/list, json endpoints",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-devtools-json");
          const { version, list, listAlias } = yield* worker.fetchJson<{
            version: { Browser: string; "Protocol-Version": string };
            list: Array<Record<string, unknown>>;
            listAlias: Array<Record<string, unknown>>;
          }>("/devtools-json");
          expect(typeof version.Browser).toBe("string");
          expect(typeof version["Protocol-Version"]).toBe("string");
          expect(Array.isArray(list)).toBe(true);
          // The page title for about:blank can change between sequential
          // requests (from "" to "about:blank"), so strip the volatile `title`
          // field before comparing the two alias endpoints.
          const stripTitle = (arr: Array<Record<string, unknown>>) =>
            arr.map(({ title: _title, ...rest }) => rest);
          expect(stripTitle(list)).toEqual(stripTitle(listAlias));
        }),
      { timeout: 60_000 },
    );

    test(
      "DELETE /v1/devtools/browser/:session_id closes browser",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker(
            "browser-devtools-delete",
          );
          const { deleteStatus, deleteBody, sessionGone, wsClosed } =
            yield* worker.fetchJson<{
              deleteStatus: number;
              deleteBody: { status: string };
              sessionGone: boolean;
              wsClosed: boolean;
            }>("/devtools-delete");
          expect(deleteStatus).toBe(200);
          expect(deleteBody.status).toBe("closed");
          expect(sessionGone).toBe(true);
          expect(wsClosed).toBe(true);
        }),
      { timeout: 60_000 },
    );

    test(
      "POST /v1/devtools/browser acquires session, GET /v1/devtools/browser/:id connects and returns cf-browser-session-id",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker(
            "browser-devtools-browser-ws",
          );
          const {
            postStatus,
            sessionId,
            getStatus,
            sessionIdFromGet,
            browserProduct,
          } = yield* worker.fetchJson<{
            postStatus: number;
            sessionId: string;
            getStatus: number;
            sessionIdFromGet: string;
            browserProduct: string;
          }>("/devtools-browser-ws");
          expect(postStatus).toBe(200);
          expect(typeof sessionId).toBe("string");
          expect(getStatus).toBe(101);
          expect(sessionIdFromGet).toBe(sessionId);
          expect(typeof browserProduct).toBe("string");
          expect(browserProduct).toContain("Chrome");
        }),
      { timeout: 60_000 },
    );

    test(
      "GET /v1/devtools/browser acquires and connects",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker(
            "browser-devtools-browser-get",
          );
          const { status, sessionId, browserProduct } =
            yield* worker.fetchJson<{
              status: number;
              sessionId: string;
              browserProduct: string;
            }>("/devtools-browser-get");
          expect(status).toBe(101);
          expect(typeof sessionId).toBe("string");
          expect(typeof browserProduct).toBe("string");
          expect(browserProduct).toContain("Chrome");
        }),
      { timeout: 60_000 },
    );

    test(
      "devtools json/protocol endpoint",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-json-protocol");
          const { hasDomains } = yield* worker.fetchJson<{
            hasDomains: boolean;
          }>("/json-protocol");
          expect(hasDomains).toBe(true);
        }),
      { timeout: 60_000 },
    );

    test(
      "devtools json/new, json/activate, json/close endpoints",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-json-new");
          const { targetType, activateStatus, closeStatus } =
            yield* worker.fetchJson<{
              targetType: string;
              activateStatus: number;
              closeStatus: number;
            }>("/json-new-activate-close");
          expect(targetType).toBe("page");
          expect(activateStatus).toBe(200);
          expect(closeStatus).toBe(200);
        }),
      { timeout: 60_000 },
    );

    test(
      "devtools page/:target_id WebSocket endpoint",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-page-ws");
          const { resultValue } = yield* worker.fetchJson<{
            resultValue: number;
          }>("/page-ws");
          expect(resultValue).toBe(2);
        }),
      { timeout: 60_000 },
    );

    test(
      "DELETE without prior WebSocket connection",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-delete-no-ws");
          const { deleteStatus, deleteBody, sessionGone } =
            yield* worker.fetchJson<{
              deleteStatus: number;
              deleteBody: { status: string };
              sessionGone: boolean;
            }>("/delete-no-ws");
          expect(deleteStatus).toBe(200);
          expect(deleteBody.status).toBe("closed");
          expect(sessionGone).toBe(true);
        }),
      { timeout: 60_000 },
    );

    test(
      "DELETE closes all WebSocket connections (browser + page)",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-delete-all-ws");
          const { deleteStatus, deleteBody, browserWsClosed, pageWsClosed } =
            yield* worker.fetchJson<{
              deleteStatus: number;
              deleteBody: { status: string };
              browserWsClosed: boolean;
              pageWsClosed: boolean;
            }>("/delete-all-ws");
          expect(deleteStatus).toBe(200);
          expect(deleteBody.status).toBe("closed");
          expect(browserWsClosed).toBe(true);
          expect(pageWsClosed).toBe(true);
        }),
      { timeout: 60_000 },
    );

    test(
      "multiple concurrent raw WebSocket connections to same session",
      () =>
        Effect.gen(function* () {
          const worker = yield* startBrowserTestWorker("browser-multi-ws");
          const { product1, product2 } = yield* worker.fetchJson<{
            product1: string;
            product2: string;
          }>("/multi-ws");
          expect(typeof product1).toBe("string");
          expect(product1).toContain("Chrome");
          expect(typeof product2).toBe("string");
          expect(product2).toContain("Chrome");
        }),
      { timeout: 60_000 },
    );
  },
);

// -----------------------------------------------------------------------------
// No-orphan invariant: closing a launched Chrome must kill the tracked pid
// (and, on POSIX, its whole process group — Chrome's renderer/GPU/utility
// helpers share the detached group, so a dead group proves no orphans).
// This pins the `closeBrowserProcess` teardown path directly, node-side,
// without workerd in the loop.
// -----------------------------------------------------------------------------

/** Is `pid` (or, negative, its process group) still alive? */
function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // EPERM etc. — the process exists but we can't signal it.
    return true;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describe("Chrome process teardown", () => {
  it(
    "closeBrowserProcess kills the whole Chrome process tree and is idempotent",
    { timeout: 240_000 }, // first launch may download Chrome into the shared cache
    async () => {
      const { browserProcess } = await Browser.launchBrowser({
        headful: false,
      });
      const pid = browserProcess.nodeProcess.pid;
      expect(typeof pid).toBe("number");
      expect(isAlive(pid!)).toBe(true);

      await Browser.closeBrowserProcess(browserProcess);

      // close() resolving means the root process exited.
      expect(await waitUntilDead(pid!, 10_000)).toBe(true);
      if (process.platform !== "win32") {
        // Chrome is spawned detached as its own process-group leader; the
        // group being gone proves every child in the tree died too.
        expect(await waitUntilDead(-pid!, 10_000)).toBe(true);
      }

      // Idempotent: closing an already-dead process resolves without throwing.
      await Browser.closeBrowserProcess(browserProcess);
    },
  );
});
