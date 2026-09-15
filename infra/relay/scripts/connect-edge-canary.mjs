// Connect a running local T3 server to the disposable edge canary Worker so a
// real browser or phone can use the T3 relay transport end to end, without
// deploying the API Worker, PlanetScale, or Clerk.
//
// Usage (from infra/relay, after `alchemy deploy alchemy.edge-canary.run.ts`):
//   T3_RELAY_CANARY_URL=https://<worker>.workers.dev \
//   T3_RELAY_CANARY_CONNECTOR_TOKEN=... T3_RELAY_CANARY_CONTROL_TOKEN=... \
//   bun scripts/connect-edge-canary.mjs http://127.0.0.1:3773
//
// The script configures the canary endpoint, starts the host connector against
// the given loopback origin, and prints the public URL. Stop it with Ctrl-C.
import { T3RelayConnectorSession } from "../../../apps/server/src/cloud/T3RelayConnector.ts";

const workerUrl = process.env.T3_RELAY_CANARY_URL;
const connectorToken = process.env.T3_RELAY_CANARY_CONNECTOR_TOKEN;
const controlToken = process.env.T3_RELAY_CANARY_CONTROL_TOKEN;
const originUrl = process.argv[2] ?? "http://127.0.0.1:3773/";

if (!workerUrl || !connectorToken || !controlToken) {
  throw new Error(
    "T3_RELAY_CANARY_URL, T3_RELAY_CANARY_CONNECTOR_TOKEN, and T3_RELAY_CANARY_CONTROL_TOKEN are required.",
  );
}

const configure = await fetch(new URL("/__t3-relay-canary/configure", workerUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${controlToken}` },
});
if (configure.status !== 204) {
  throw new Error(`Canary configuration failed with ${configure.status}.`);
}

const connectorUrl = new URL("/.well-known/t3-relay/connect", workerUrl);
connectorUrl.protocol = "wss:";
const session = new T3RelayConnectorSession(
  { connectorUrl: connectorUrl.href, connectorToken, originUrl },
  undefined,
  undefined,
  (event) => {
    const stamp = new Date().toISOString();
    if (event.type === "connected") {
      console.log(`${stamp} connected. Public origin: ${workerUrl}`);
    } else if (event.type === "disconnected") {
      console.log(`${stamp} disconnected code=${event.code} reason=${event.reason}`);
    } else if (event.type === "retry_scheduled") {
      console.log(
        `${stamp} retry #${event.attempt} in ${event.delayMillis}ms reason=${event.reason}`,
      );
    }
  },
);
session.start();
console.log(`Forwarding ${workerUrl} -> ${originUrl}`);

const stop = () => {
  session.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => undefined);
