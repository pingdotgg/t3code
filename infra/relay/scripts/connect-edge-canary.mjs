// Connect a running local T3 server to the edge canary Worker so a real
// browser or phone can use the T3 relay transport end to end, without
// deploying the API Worker, PlanetScale, or Clerk.
//
// Usage (from infra/relay, after `alchemy deploy alchemy.edge-canary.run.ts`
// or `alchemy dev alchemy.edge-canary.run.ts`):
//   T3_RELAY_CANARY_URL=https://<worker>.workers.dev \
//   T3_RELAY_CANARY_CONTROL_TOKEN=... \
//   bun scripts/connect-edge-canary.mjs http://127.0.0.1:3773 [userKey] [endpointKey]
//
// The script configures one endpoint on the user's hub object, starts the
// host connector against the given loopback origin, and prints the public
// URL prefix. Stop it with Ctrl-C.
import * as NodeCrypto from "node:crypto";

import { T3RelayConnectorSession } from "../../../apps/server/src/cloud/T3RelayConnector.ts";

const workerUrl = process.env.T3_RELAY_CANARY_URL;
const controlToken = process.env.T3_RELAY_CANARY_CONTROL_TOKEN;
const originUrl = process.argv[2] ?? "http://127.0.0.1:3773/";
const userKey = process.argv[3] ?? "0123456789abcdef";
const endpointKey = process.argv[4] ?? "fedcba9876543210";

if (!workerUrl || !controlToken) {
  throw new Error("T3_RELAY_CANARY_URL and T3_RELAY_CANARY_CONTROL_TOKEN are required.");
}

const connectorToken = NodeCrypto.randomBytes(24).toString("base64url");
const configureUrl = new URL("/__t3-relay-canary/configure", workerUrl);
configureUrl.searchParams.set("userKey", userKey);
configureUrl.searchParams.set("endpointKey", endpointKey);
configureUrl.searchParams.set("connectorToken", connectorToken);
configureUrl.searchParams.set("connectorLeaseId", `lease-${Date.now()}`);
const configure = await fetch(configureUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${controlToken}` },
});
if (configure.status !== 204) {
  throw new Error(`Canary configuration failed with ${configure.status}.`);
}

const publicUrl = new URL(`/u/${userKey}/e/${endpointKey}/`, workerUrl);
const connectorUrl = new URL(
  `/u/${userKey}/e/${endpointKey}/.well-known/t3-relay/connect`,
  workerUrl,
);
connectorUrl.protocol = connectorUrl.protocol === "https:" ? "wss:" : "ws:";
const session = new T3RelayConnectorSession(
  { connectorUrl: connectorUrl.href, connectorToken, originUrl },
  undefined,
  undefined,
  (event) => {
    const stamp = new Date().toISOString();
    if (event.type === "connected") {
      console.log(`${stamp} connected. Public origin: ${publicUrl.href}`);
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
console.log(`Forwarding ${publicUrl.href} -> ${originUrl}`);

const stop = () => {
  session.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => undefined);
