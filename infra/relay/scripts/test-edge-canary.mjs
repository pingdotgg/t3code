import { T3RelayConnectorSession } from "../../../apps/server/src/cloud/T3RelayConnector.ts";

const workerUrl = process.env.T3_RELAY_CANARY_URL;
const connectorToken = process.env.T3_RELAY_CANARY_CONNECTOR_TOKEN;
const controlToken = process.env.T3_RELAY_CANARY_CONTROL_TOKEN;

if (!workerUrl || !connectorToken || !controlToken) {
  throw new Error(
    "T3_RELAY_CANARY_URL, T3_RELAY_CANARY_CONNECTOR_TOKEN, and T3_RELAY_CANARY_CONTROL_TOKEN are required.",
  );
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

function control(pathname, method = "GET") {
  return fetch(new URL(`/__t3-relay-canary/${pathname}`, workerUrl), {
    method,
    headers: { authorization: `Bearer ${controlToken}` },
  });
}

async function configureCanary() {
  const deadline = Date.now() + 15_000;
  let lastStatus = 0;
  for (;;) {
    const response = await control("configure", "POST");
    lastStatus = response.status;
    if (response.status === 204) return;
    await response.arrayBuffer();
    if ((response.status < 500 && response.status !== 404) || Date.now() >= deadline) {
      throw new Error(`Canary configuration failed with ${lastStatus}.`);
    }
    await Bun.sleep(250);
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

const HUGE_CHUNKS = 256;
const HUGE_CHUNK_BYTES = 64 * 1024;

const DRIP_CHUNKS = 16;
const DRIP_CHUNK_BYTES = 1024;
const DRIP_INTERVAL_MS = 5_000;

const largeResponse = new Uint8Array(512 * 1024);
for (let index = 0; index < largeResponse.length; index += 1) {
  largeResponse[index] = index % 251;
}

let originWebSocketMessageCount = 0;
const origin = Bun.serve({
  port: 0,
  fetch: async (request, server) => {
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
      // Emit a chunk every few seconds for longer than the idle window.
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
      // Far larger than the edge and client buffers, so an abandoned reader
      // really does stall the object on flow control.
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
      // The connector must ask for identity encoding. If it does not, Node's
      // fetch decodes this body but keeps content-encoding, and the browser
      // then fails to decode plain bytes as gzip.
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
      method: request.method,
      pathname: url.pathname,
      bodyBytes: body.byteLength,
      canaryHeader: request.headers.get("x-canary"),
    });
  },
  websocket: {
    message(socket, message) {
      originWebSocketMessageCount += 1;
      socket.send(message);
    },
  },
});

const lifecycle = [];
const connectorUrl = new URL("/.well-known/t3-relay/connect", workerUrl);
connectorUrl.protocol = "wss:";
const session = new T3RelayConnectorSession(
  {
    connectorUrl: connectorUrl.href,
    connectorToken,
    originUrl: origin.url.href,
  },
  undefined,
  undefined,
  (event) => lifecycle.push(event),
);

try {
  // A just-deployed Worker can briefly route before its Durable Object binding
  // has converged at every edge. Retry only propagation-shaped failures.
  await configureCanary();

  session.start();
  await waitFor(
    () => lifecycle.some((event) => event.type === "connected"),
    "Connector did not reach connected state.",
  );
  const connectedDiagnostics = await (await control("diagnostics")).json();
  assert(
    connectedDiagnostics.connectorConnected,
    `Durable Object lost the connector after handshake: ${JSON.stringify(lifecycle)}`,
  );

  const requestBody = new Uint8Array(8 * 1024);
  const httpResponse = await fetch(new URL("/echo?source=canary", workerUrl), {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-canary": "edge" },
    body: requestBody,
  });
  assert(httpResponse.ok, `Public HTTP request failed with ${httpResponse.status}.`);
  const echoed = await httpResponse.json();
  assert(echoed.method === "POST", "HTTP method was not preserved.");
  assert(echoed.pathname === "/echo", "HTTP pathname was not preserved.");
  assert(echoed.bodyBytes === requestBody.byteLength, "HTTP request body was truncated.");
  assert(echoed.canaryHeader === "edge", "HTTP request headers were not preserved.");

  const largeHttpResponse = await fetch(new URL("/large", workerUrl));
  if (!largeHttpResponse.ok) {
    throw new Error(
      `Flow-controlled response failed with ${largeHttpResponse.status}: ${await largeHttpResponse.text()}`,
    );
  }
  const streamed = new Uint8Array(await largeHttpResponse.arrayBuffer());
  assert(
    streamed.length === largeResponse.length,
    `Flow-controlled response was truncated (${streamed.length}/${largeResponse.length} bytes).`,
  );
  assert(
    streamed.every((byte, index) => byte === largeResponse[index]),
    "Response bytes changed.",
  );

  const noContent = await fetch(new URL("/no-content", workerUrl));
  assert(noContent.status === 204, `204 response became ${noContent.status}.`);
  assert(noContent.headers.get("x-canary-empty") === "yes", "204 response lost its headers.");
  await noContent.arrayBuffer();
  const notModified = await fetch(new URL("/not-modified", workerUrl), { cache: "no-store" });
  assert(notModified.status === 304, `304 response became ${notModified.status}.`);
  await notModified.arrayBuffer();

  const compressed = await fetch(new URL("/compressed", workerUrl));
  assert(compressed.ok, `Compressed origin response failed with ${compressed.status}.`);
  assert(
    (await compressed.text()) === "compressed-canary",
    "Compressed origin response was not decoded correctly.",
  );
  assert(
    compressed.headers.get("x-canary-encoding") === "identity",
    "Connector did not request identity encoding from the origin.",
  );

  const textResult = await websocketRoundTrip(
    new URL("/ws", workerUrl).href.replace(/^http/u, "ws"),
    "relay-canary-text",
  );
  assert(textResult === "relay-canary-text", "WebSocket text round trip changed the message.");

  const binaryMessage = new Uint8Array(192 * 1024);
  for (let index = 0; index < binaryMessage.length; index += 1) binaryMessage[index] = index % 239;
  const binaryResult = await websocketRoundTrip(
    new URL("/ws", workerUrl).href.replace(/^http/u, "ws"),
    binaryMessage,
  );
  assert(binaryResult instanceof Uint8Array, "WebSocket binary response became text.");
  assert(
    binaryResult.length === binaryMessage.length,
    "Fragmented WebSocket response was truncated.",
  );
  assert(
    binaryResult.every((byte, index) => byte === binaryMessage[index]),
    "Fragmented WebSocket response bytes changed.",
  );

  const messagesBeforePing = originWebSocketMessageCount;
  const pingResult = await websocketRoundTrip(
    new URL("/ws", workerUrl).href.replace(/^http/u, "ws"),
    '{"_tag":"Ping"}',
  );
  assert(pingResult === '{"_tag":"Pong"}', "Effect RPC ping was not answered at the edge.");
  assert(
    originWebSocketMessageCount === messagesBeforePing,
    "Effect RPC ping reached the origin instead of using the Durable Object auto-response.",
  );

  // Slow reader: the origin drips a body over ~75 s, longer than the 60 s
  // idle window, while every chunk keeps arriving well inside it. This must
  // complete; only a reader that stops making progress is cut off.
  const slowStartedAt = Date.now();
  const slowResponse = await fetch(new URL("/drip", workerUrl));
  assert(slowResponse.ok, `Slow-reader response failed with ${slowResponse.status}.`);
  const slowBytes = new Uint8Array(await slowResponse.arrayBuffer());
  const slowElapsed = Date.now() - slowStartedAt;
  assert(slowBytes.length === DRIP_CHUNKS * DRIP_CHUNK_BYTES, "Slow reader body was truncated.");
  assert(
    slowElapsed > 60_000,
    `Slow reader finished in ${slowElapsed} ms; it did not span the idle window.`,
  );

  // Abandoned reader: open a 16 MiB download, read one chunk, then stop.
  // Cloudflare's edge buffers the whole body from the object, so the object
  // finishes streaming and drops the pending request on its own within a few
  // seconds; it does not stay awake for the client. The 60 s idle watchdog in
  // the object covers bodies larger than the edge will buffer.
  const abandoned = await fetch(new URL("/huge", workerUrl));
  assert(abandoned.ok, `Abandoned response failed with ${abandoned.status}.`);
  const abandonedReader = abandoned.body.getReader();
  await abandonedReader.read();
  const abandonedAt = Date.now();
  let abandonedPending = 1;
  while (abandonedPending > 0 && Date.now() - abandonedAt < 30_000) {
    await Bun.sleep(1_000);
    abandonedPending = (await (await control("diagnostics")).json()).pendingHttpCount;
  }
  assert(abandonedPending === 0, "Abandoned download stayed pending in the Durable Object.");

  const beforeIdle = await (await control("diagnostics")).json();
  assert(beforeIdle.connectorConnected, "Connector was not visible in Durable Object diagnostics.");
  await Bun.sleep(20_000);
  const afterIdle = await (await control("diagnostics")).json();
  assert(afterIdle.connectorConnected, "Connector was not restored after Durable Object wake.");
  await abandonedReader.cancel().catch(() => undefined);
  assert(
    afterIdle.activationId !== beforeIdle.activationId,
    "Durable Object did not hibernate during the idle validation window.",
  );

  const afterWake = await fetch(new URL("/after-wake", workerUrl));
  assert(afterWake.ok, "HTTP forwarding failed after Durable Object wake.");

  const revoke = await control("revoke", "POST");
  assert(revoke.ok && (await revoke.json()).revoked, "Revocation failed.");
  await waitFor(
    () => lifecycle.some((event) => event.type === "disconnected"),
    "Connector did not disconnect after revocation.",
  );
  const revokedResponse = await fetch(new URL("/revoked", workerUrl));
  assert(revokedResponse.status === 503, "Revoked endpoint continued forwarding traffic.");

  console.log(
    JSON.stringify({
      http: "passed",
      flowControl: "passed",
      emptyBodyStatuses: "passed",
      identityEncoding: "passed",
      websocketText: "passed",
      websocketFragmentation: "passed",
      websocketAutoResponse: "passed",
      slowReader: "passed",
      abandonedReader: "passed",
      hibernation: "passed",
      revocation: "passed",
    }),
  );
} finally {
  session.close();
  await origin.stop(true);
}
