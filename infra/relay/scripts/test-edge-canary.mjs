// End-to-end validation of the T3 relay edge against a deployed or local
// canary Worker. Two users share the Worker; user A has two environments on
// one hub object and user B has one on another, so the run covers isolation
// between endpoints on the same object and between objects.
//
//   T3_RELAY_CANARY_URL=https://<worker>.workers.dev \
//   T3_RELAY_CANARY_CONTROL_TOKEN=... bun scripts/test-edge-canary.mjs
//
// Set T3_RELAY_CANARY_FAST=1 to skip the multi-minute idle and hibernation
// checks, which only mean something against real Cloudflare infrastructure.
// Whether the two users share one hub object is read from the objects
// themselves, so the run is valid for any RELAY_HUB_SHARD_COUNT. Set
// T3_RELAY_CANARY_SHARED_HUB=1 to require that they share one.
import * as NodeCrypto from "node:crypto";

import { T3RelayConnectorSession } from "../../../apps/server/src/cloud/T3RelayConnector.ts";

const workerUrl = process.env.T3_RELAY_CANARY_URL;
const controlToken = process.env.T3_RELAY_CANARY_CONTROL_TOKEN;
const fast = process.env.T3_RELAY_CANARY_FAST === "1";
const requireSharedHub = process.env.T3_RELAY_CANARY_SHARED_HUB === "1";

if (!workerUrl || !controlToken) {
  throw new Error("T3_RELAY_CANARY_URL and T3_RELAY_CANARY_CONTROL_TOKEN are required.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMillis = 15_000) {
  const deadline = Date.now() + timeoutMillis;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(25);
  }
}

const HUGE_CHUNKS = 256;
const HUGE_CHUNK_BYTES = 64 * 1024;
const DRIP_CHUNKS = 16;
const DRIP_CHUNK_BYTES = 1024;
const DRIP_INTERVAL_MS = 5_000;

const largeResponse = new Uint8Array(512 * 1024);
for (let index = 0; index < largeResponse.length; index += 1) {
  largeResponse[index] = index % 251;
}

// One loopback origin per endpoint so a misrouted request is visible by name.
function makeOrigin(name) {
  const stats = { webSocketMessages: 0, requests: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (request, server) => {
      stats.requests += 1;
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/large") {
        return new Response(largeResponse, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.pathname === "/drip") {
        let sent = 0;
        const body = new ReadableStream({
          async pull(controller) {
            if (sent >= DRIP_CHUNKS) {
              controller.close();
              return;
            }
            if (sent > 0) await Bun.sleep(DRIP_INTERVAL_MS);
            controller.enqueue(new Uint8Array(DRIP_CHUNK_BYTES));
            sent += 1;
          },
        });
        return new Response(body, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.pathname === "/huge") {
        let sent = 0;
        const body = new ReadableStream({
          pull(controller) {
            if (sent >= HUGE_CHUNKS) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(HUGE_CHUNK_BYTES));
            sent += 1;
          },
        });
        return new Response(body, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.pathname === "/no-content") {
        return new Response(null, { status: 204, headers: { "x-canary-empty": "yes" } });
      }
      if (url.pathname === "/not-modified") {
        return new Response(null, { status: 304, headers: { etag: '"canary"' } });
      }
      if (url.pathname === "/compressed") {
        const acceptEncoding = request.headers.get("accept-encoding") ?? "";
        if (acceptEncoding.includes("gzip")) {
          return new Response(Bun.gzipSync(new TextEncoder().encode("compressed-canary")), {
            headers: { "content-type": "text/plain", "content-encoding": "gzip" },
          });
        }
        return new Response("compressed-canary", {
          headers: { "content-type": "text/plain", "x-canary-encoding": acceptEncoding },
        });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      return Response.json({
        origin: name,
        method: request.method,
        pathname: url.pathname,
        bodyBytes: body.byteLength,
        canaryHeader: request.headers.get("x-canary"),
      });
    },
    websocket: {
      message(socket, message) {
        stats.webSocketMessages += 1;
        socket.send(typeof message === "string" ? `${name}:${message}` : message);
      },
    },
  });
  return { name, server, stats };
}

function hexKey() {
  return NodeCrypto.randomBytes(8).toString("hex");
}

class Endpoint {
  constructor(name, userKey) {
    this.name = name;
    this.userKey = userKey;
    this.endpointKey = hexKey();
    this.connectorToken = NodeCrypto.randomBytes(24).toString("base64url");
    this.leaseId = `lease-${name}-1`;
    this.origin = makeOrigin(name);
    this.lifecycle = [];
    this.session = null;
    this.restartSession();
  }

  restartSession() {
    this.session?.close();
    this.session = null;
    const connectorUrl = this.publicUrl("/.well-known/t3-relay/connect");
    connectorUrl.protocol = connectorUrl.protocol === "https:" ? "wss:" : "ws:";
    this.session = new T3RelayConnectorSession(
      {
        connectorUrl: connectorUrl.href,
        connectorToken: this.connectorToken,
        originUrl: this.origin.server.url.href,
      },
      undefined,
      undefined,
      (event) => this.lifecycle.push(event),
    );
  }

  publicUrl(pathname) {
    return new URL(`/u/${this.userKey}/e/${this.endpointKey}${pathname}`, workerUrl);
  }

  wsUrl(pathname) {
    return this.publicUrl(pathname).href.replace(/^http/u, "ws");
  }

  control(operation, method = "GET", extra = {}) {
    const url = new URL(`/__t3-relay-canary/${operation}`, workerUrl);
    url.searchParams.set("userKey", this.userKey);
    url.searchParams.set("endpointKey", this.endpointKey);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return fetch(url, { method, headers: { authorization: `Bearer ${controlToken}` } });
  }

  async configure(leaseId = this.leaseId) {
    this.leaseId = leaseId;
    // A just-deployed Worker can briefly route before its Durable Object
    // binding has converged at every edge. Retry only propagation failures.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const response = await this.control("configure", "POST", {
        connectorToken: this.connectorToken,
        connectorLeaseId: leaseId,
      });
      if (response.status === 204) return;
      await response.arrayBuffer();
      if ((response.status < 500 && response.status !== 404) || Date.now() >= deadline) {
        throw new Error(`Canary configuration failed with ${response.status}.`);
      }
      await Bun.sleep(250);
    }
  }

  async diagnostics() {
    const hub = await (await this.control("diagnostics")).json();
    return { hub, endpoint: hub.endpoints[this.endpointKey] ?? null };
  }

  async connect() {
    this.session.start();
    const before = this.lifecycle.length;
    await waitFor(
      () => this.lifecycle.slice(before).some((event) => event.type === "connected"),
      `${this.name}: connector did not reach connected state: ${JSON.stringify(this.lifecycle)}`,
    );
  }

  async close() {
    this.session.close();
    await this.origin.server.stop(true);
  }
}

async function websocketRoundTrip(url, message) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Public WebSocket round trip timed out."));
    }, 15_000);
    socket.addEventListener("open", () => socket.send(message));
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Public WebSocket failed."));
    });
  });
}

async function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const closed = new Promise((resolveClose) =>
      socket.addEventListener("close", (event) => resolveClose(event)),
    );
    socket.addEventListener("open", () => resolve({ socket, closed }));
    socket.addEventListener("error", () => reject(new Error("WebSocket open failed.")));
  });
}

async function echo(endpoint, pathname, init) {
  const response = await fetch(endpoint.publicUrl(pathname), init);
  assert(response.ok, `${endpoint.name}: request ${pathname} failed with ${response.status}.`);
  return response.json();
}

// User A owns two environments on one hub; user B owns one on another hub.
const userA = hexKey();
const userB = hexKey();
const a1 = new Endpoint("a1", userA);
const a2 = new Endpoint("a2", userA);
const b1 = new Endpoint("b1", userB);
const endpoints = [a1, a2, b1];
const results = {};

try {
  // Hub objects keep storage across runs, so count configured endpoints
  // relative to what the objects already held.
  const hubBeforeA = (await a1.diagnostics()).hub;
  const hubBeforeB = (await b1.diagnostics()).hub;
  const sharedHub = hubBeforeA.activationId === hubBeforeB.activationId;
  assert(!requireSharedHub || sharedHub, "users A and B did not share one object.");
  const baselineA = hubBeforeA.configuredEndpointCount;
  const baselineB = hubBeforeB.configuredEndpointCount;
  for (const endpoint of endpoints) await endpoint.configure();
  for (const endpoint of endpoints) await endpoint.connect();

  // Every endpoint is reachable and answered by its own origin.
  for (const endpoint of endpoints) {
    const echoed = await echo(endpoint, "/echo?source=canary", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-canary": endpoint.name },
      body: new Uint8Array(8 * 1024),
    });
    assert(echoed.origin === endpoint.name, `${endpoint.name} reached origin ${echoed.origin}.`);
    assert(echoed.method === "POST", "HTTP method was not preserved.");
    assert(echoed.pathname === "/echo", "HTTP pathname was not preserved.");
    assert(echoed.bodyBytes === 8 * 1024, "HTTP request body was truncated.");
    assert(echoed.canaryHeader === endpoint.name, "HTTP request headers were not preserved.");
    const text = await websocketRoundTrip(endpoint.wsUrl("/ws"), "hello");
    assert(text === `${endpoint.name}:hello`, `${endpoint.name} WebSocket answered ${text}.`);
  }
  results.routing = "passed";

  // Both of user A's endpoints live in one object; user B's does not.
  const hubA = (await a1.diagnostics()).hub;
  const hubB = (await b1.diagnostics()).hub;
  assert(hubA.endpoints[a1.endpointKey]?.connectorConnected, "a1 missing from hub A.");
  assert(hubA.endpoints[a2.endpointKey]?.connectorConnected, "a2 missing from hub A.");
  assert(hubB.endpoints[b1.endpointKey]?.connectorConnected, "b1 missing from hub B.");
  const expectedConfiguredA = baselineA + (sharedHub ? 3 : 2);
  assert(
    hubA.configuredEndpointCount === expectedConfiguredA,
    `hub A configured ${hubA.configuredEndpointCount}, expected ${expectedConfiguredA}.`,
  );
  if (!sharedHub) {
    assert(hubA.endpoints[b1.endpointKey] === undefined, "b1 leaked into hub A.");
    assert(hubB.endpoints[a1.endpointKey] === undefined, "a1 leaked into hub B.");
    assert(hubB.configuredEndpointCount === baselineB + 1, "hub B configured count drifted.");
    assert(hubA.activationId !== hubB.activationId, "users A and B share one object.");
  }
  results.isolation = "passed";

  // An unknown endpoint on a live hub is offline, not served by a neighbor.
  const unknown = await fetch(new URL(`/u/${userA}/e/${hexKey()}/echo`, workerUrl));
  assert(unknown.status === 503, `Unknown endpoint answered ${unknown.status}.`);
  await unknown.arrayBuffer();
  // A connector credential of one endpoint cannot open another endpoint.
  const crossTicket = await fetch(a2.publicUrl("/.well-known/t3-relay/connect"), {
    method: "POST",
    headers: { authorization: `Bearer ${a1.connectorToken}` },
  });
  assert(crossTicket.status === 401, `Cross-endpoint ticket answered ${crossTicket.status}.`);
  await crossTicket.arrayBuffer();
  results.credentialScoping = "passed";

  // Concurrent traffic on sibling endpoints stays separated under load.
  const mixed = await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const endpoint = endpoints[index % endpoints.length];
      return echo(endpoint, `/mixed/${index}`).then((body) => [endpoint.name, body.origin]);
    }),
  );
  assert(
    mixed.every(([expected, actual]) => expected === actual),
    `Concurrent responses crossed endpoints: ${JSON.stringify(mixed)}`,
  );
  results.concurrency = "passed";

  // Flow control, empty-body statuses, identity encoding, fragmentation, and
  // the edge-handled Effect RPC ping, all on a1 while a2 stays connected.
  const largeHttpResponse = await fetch(a1.publicUrl("/large"));
  assert(largeHttpResponse.ok, `Flow-controlled response failed with ${largeHttpResponse.status}.`);
  const streamed = new Uint8Array(await largeHttpResponse.arrayBuffer());
  assert(streamed.length === largeResponse.length, "Flow-controlled response was truncated.");
  assert(
    streamed.every((byte, index) => byte === largeResponse[index]),
    "Response bytes changed.",
  );
  results.flowControl = "passed";

  const noContent = await fetch(a1.publicUrl("/no-content"));
  assert(noContent.status === 204, `204 response became ${noContent.status}.`);
  assert(noContent.headers.get("x-canary-empty") === "yes", "204 response lost its headers.");
  await noContent.arrayBuffer();
  const notModified = await fetch(a1.publicUrl("/not-modified"), { cache: "no-store" });
  assert(notModified.status === 304, `304 response became ${notModified.status}.`);
  await notModified.arrayBuffer();
  results.emptyBodyStatuses = "passed";

  const compressed = await fetch(a1.publicUrl("/compressed"));
  assert(compressed.ok, `Compressed origin response failed with ${compressed.status}.`);
  assert((await compressed.text()) === "compressed-canary", "Compressed body was not decoded.");
  assert(
    compressed.headers.get("x-canary-encoding") === "identity",
    "Connector did not request identity encoding from the origin.",
  );
  results.identityEncoding = "passed";

  const binaryMessage = new Uint8Array(192 * 1024);
  for (let index = 0; index < binaryMessage.length; index += 1) binaryMessage[index] = index % 239;
  const binaryResult = await websocketRoundTrip(a1.wsUrl("/ws"), binaryMessage);
  assert(binaryResult instanceof Uint8Array, "WebSocket binary response became text.");
  assert(binaryResult.length === binaryMessage.length, "Fragmented response was truncated.");
  assert(
    binaryResult.every((byte, index) => byte === binaryMessage[index]),
    "Fragmented WebSocket response bytes changed.",
  );
  results.websocketFragmentation = "passed";

  const messagesBeforePing = a1.origin.stats.webSocketMessages;
  const pingResult = await websocketRoundTrip(a1.wsUrl("/ws"), '{"_tag":"Ping"}');
  assert(pingResult === '{"_tag":"Pong"}', "Effect RPC ping was not answered at the edge.");
  assert(
    a1.origin.stats.webSocketMessages === messagesBeforePing,
    "Effect RPC ping reached the origin instead of the Durable Object auto-response.",
  );
  results.websocketAutoResponse = "passed";

  // Relinking a2 supersedes its connector while a1's socket stays open, and
  // a release with a2's stale lease returns false and leaves the new one up.
  const held = await openWebSocket(a1.wsUrl("/ws"));
  const a2Disconnects = a2.lifecycle.filter((event) => event.type === "disconnected").length;
  a2.connectorToken = NodeCrypto.randomBytes(24).toString("base64url");
  await a2.configure("lease-a2-2");
  await waitFor(
    () => a2.lifecycle.filter((event) => event.type === "disconnected").length > a2Disconnects,
    "a2 connector was not superseded by the relink.",
  );
  a2.restartSession();
  await a2.connect();
  const staleRelease = await (
    await a2.control("revoke", "POST", { connectorLeaseId: "lease-a2-1" })
  ).json();
  assert(staleRelease.revoked === false, "Stale lease revoked the relinked connector.");
  assert((await a2.diagnostics()).endpoint?.connectorConnected, "a2 dropped after stale release.");
  assert(held.socket.readyState === WebSocket.OPEN, "a1 client socket dropped during a2 relink.");
  const heldEcho = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Held WebSocket echo timed out.")), 15_000);
    const settle = (callback) => (event) => {
      clearTimeout(timeout);
      callback(event);
    };
    held.socket.addEventListener(
      "message",
      settle((event) => resolve(event.data)),
      { once: true },
    );
    held.socket.addEventListener(
      "close",
      settle(() => reject(new Error("Held WebSocket closed."))),
      {
        once: true,
      },
    );
    held.socket.addEventListener(
      "error",
      settle(() => reject(new Error("Held WebSocket failed."))),
      {
        once: true,
      },
    );
    held.socket.send("still-here");
  });
  assert(heldEcho === "a1:still-here", "a1 client socket stopped forwarding after a2 relink.");
  held.socket.close();
  results.relink = "passed";

  // A host that reconnects while its old socket is still open (sleep/wake,
  // network switch) must end up on a live table: the superseded socket is
  // closed and traffic flows through the new one.
  const staleSession = b1.session;
  const staleDisconnects = b1.lifecycle.filter((event) => event.type === "disconnected").length;
  b1.session = null;
  b1.restartSession();
  await b1.connect();
  await waitFor(
    () => b1.lifecycle.filter((event) => event.type === "disconnected").length > staleDisconnects,
    "Superseded b1 socket was not closed by the hub.",
  );
  // Stop the stale session before its reconnect backoff fires.
  staleSession.close();
  const reconnected = await echo(b1, "/after-reconnect");
  assert(reconnected.origin === "b1", "b1 did not serve after a reconnect over a live socket.");
  const reconnectedWs = await websocketRoundTrip(b1.wsUrl("/ws"), "again");
  assert(reconnectedWs === "b1:again", "b1 WebSocket failed after reconnect.");
  assert(
    (await b1.diagnostics()).endpoint?.connectorConnected,
    "b1 not connected after reconnect.",
  );
  results.reconnect = "passed";

  if (!fast) {
    const slowStartedAt = Date.now();
    const slowResponse = await fetch(a1.publicUrl("/drip"));
    assert(slowResponse.ok, `Slow-reader response failed with ${slowResponse.status}.`);
    const slowBytes = new Uint8Array(await slowResponse.arrayBuffer());
    const slowElapsed = Date.now() - slowStartedAt;
    assert(
      slowBytes.length === DRIP_CHUNKS * DRIP_CHUNK_BYTES,
      `Slow reader body was truncated (${slowBytes.length} bytes after ${slowElapsed} ms).`,
    );
    assert(slowElapsed > 60_000, `Slow reader finished in ${slowElapsed} ms.`);
    results.slowReader = "passed";

    const abandoned = await fetch(a1.publicUrl("/huge"));
    assert(abandoned.ok, `Abandoned response failed with ${abandoned.status}.`);
    const abandonedReader = abandoned.body.getReader();
    await abandonedReader.read();
    const abandonedAt = Date.now();
    let abandonedPending = 1;
    while (abandonedPending > 0 && Date.now() - abandonedAt < 30_000) {
      await Bun.sleep(1_000);
      abandonedPending = (await a1.diagnostics()).endpoint?.pendingHttpCount ?? 0;
    }
    assert(abandonedPending === 0, "Abandoned download stayed pending in the Durable Object.");
    results.abandonedReader = "passed";

    const beforeIdle = (await a1.diagnostics()).hub;
    await Bun.sleep(20_000);
    const afterIdle = (await a1.diagnostics()).hub;
    await abandonedReader.cancel().catch(() => undefined);
    assert(
      afterIdle.activationId !== beforeIdle.activationId,
      "Durable Object did not hibernate during the idle validation window.",
    );
    assert(afterIdle.endpoints[a1.endpointKey]?.connectorConnected, "a1 lost after wake.");
    assert(afterIdle.endpoints[a2.endpointKey]?.connectorConnected, "a2 lost after wake.");
    for (const endpoint of [a1, a2, b1]) {
      const body = await echo(endpoint, "/after-wake");
      assert(body.origin === endpoint.name, `${endpoint.name} misrouted after wake.`);
    }
    results.hibernation = "passed";
  }

  // Revoking a1 stops only a1. a2 on the same object keeps serving.
  const revoke = await a1.control("revoke", "POST", { connectorLeaseId: a1.leaseId });
  assert(revoke.ok && (await revoke.json()).revoked, "Revocation failed.");
  await waitFor(
    () => a1.lifecycle.some((event) => event.type === "disconnected"),
    "a1 connector did not disconnect after revocation.",
  );
  const revokedResponse = await fetch(a1.publicUrl("/revoked"));
  assert(revokedResponse.status === 503, "Revoked endpoint continued forwarding traffic.");
  await revokedResponse.arrayBuffer();
  const survivor = await echo(a2, "/survivor");
  assert(survivor.origin === "a2", "a2 stopped serving after a1 was revoked.");
  const afterRevoke = (await a2.diagnostics()).hub;
  assert(afterRevoke.endpoints[a1.endpointKey] === undefined, "a1 state lingered after revoke.");
  assert(
    afterRevoke.configuredEndpointCount === expectedConfiguredA - 1,
    "a1 configuration lingered after revoke.",
  );
  results.revocation = "passed";

  console.log(JSON.stringify(results));
} finally {
  for (const endpoint of endpoints) await endpoint.close();
}
