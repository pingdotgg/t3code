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

  const beforeIdle = await (await control("diagnostics")).json();
  assert(beforeIdle.connectorConnected, "Connector was not visible in Durable Object diagnostics.");
  await Bun.sleep(20_000);
  const afterIdle = await (await control("diagnostics")).json();
  assert(afterIdle.connectorConnected, "Connector was not restored after Durable Object wake.");
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
      websocketText: "passed",
      websocketFragmentation: "passed",
      websocketAutoResponse: "passed",
      hibernation: "passed",
      revocation: "passed",
    }),
  );
} finally {
  session.close();
  await origin.stop(true);
}
