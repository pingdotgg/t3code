// Machines for the environments-map video. Real servers: MacBook (web, this device), studio,
// devbox, and gpu-1..3 to link by dragging; nas starts once so the browser knows it, then
// stops (offline). Link rows are seeded: studio <-> devbox both ways, and devbox -> fs-44..fs-87
// of which 7 answer through descriptor stubs. Writes <out>/stage.json. Usage: serve.mjs <out-dir>
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  REPO,
  cli,
  insertPeerLinks,
  prepareHome,
  serveDescriptors,
  startEnvironment,
} from "../../scripts/stage-env.mjs";

const out = NodePath.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: serve.mjs <out-dir>");
NodeFS.mkdirSync(out, { recursive: true });
const root = NodePath.join(REPO, ".t3/launch/environments-map");

// gpu-1/gpu-2 are linked live, so the linking server must reach them at a non-loopback tailnet
// name: they bind this machine's tailnet address and are saved under its tailnet DNS name.
const tailscale = JSON.parse(
  NodeChildProcess.execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }),
);
const tailnetName = tailscale.Self.DNSName.replace(/\.$/, "");
const tailnetIp = tailscale.Self.TailscaleIPs.find((ip) => !ip.includes(":"));

const linked = { linkedEnvironmentsEnabled: true };
const machines = {
  macbook: { label: "MacBook", machine: "laptop" },
  studio: { label: "studio", machine: "mac-studio" },
  devbox: { label: "devbox", machine: "cloud" },
  nas: { label: "nas", machine: "linux" },
  gpu1: { label: "gpu-1", machine: "cloud" },
  gpu2: { label: "gpu-2", machine: "cloud" },
  gpu3: { label: "gpu-3", machine: "cloud" },
};
for (const [name, identity] of Object.entries(machines)) {
  prepareHome(NodePath.join(root, name), { ...identity, settings: linked });
}

const home = (name) => NodePath.join(root, name);
const macbook = await startEnvironment(home("macbook"), { web: true });
const allowedOrigins = [macbook.webOrigin];
let studio = await startEnvironment(home("studio"), { allowedOrigins });
let devbox = await startEnvironment(home("devbox"), { allowedOrigins });
const nas = await startEnvironment(home("nas"), { allowedOrigins });
const gpu1 = await startEnvironment(home("gpu1"), { host: tailnetIp, allowedOrigins });
const gpu2 = await startEnvironment(home("gpu2"), { host: tailnetIp, allowedOrigins });
const gpu3 = await startEnvironment(home("gpu3"), { host: tailnetIp, allowedOrigins });
console.log("started 7 environments");

// Seeded links need the servers stopped: they read the table on start.
const fleet = Array.from({ length: 44 }, (_, i) => ({
  environmentId: NodeCrypto.randomUUID(),
  label: `fs-${44 + i}`,
}));
const reachable = await serveDescriptors(devbox.descriptor, fleet.slice(3, 10));
await Promise.all([studio.stop(), devbox.stop()]);
await insertPeerLinks(studio.home, [
  { environmentId: devbox.environmentId, label: "devbox", urls: [devbox.origin] },
]);
await insertPeerLinks(devbox.home, [
  { environmentId: studio.environmentId, label: "studio", urls: [studio.origin] },
  ...fleet.map((machine, i) => ({
    ...machine,
    access: "approval-required",
    urls: [reachable[machine.environmentId] ?? `http://127.0.0.1:${9 + i}`],
  })),
]);
studio = await startEnvironment(home("studio"), { port: studio.serverPort, allowedOrigins });
devbox = await startEnvironment(home("devbox"), { port: devbox.serverPort, allowedOrigins });
console.log("seeded links");

const token = (environment) =>
  cli(environment.home, ["auth", "session", "issue", "--token-only", "--label", "MacBook"]).trim();
const stage = {
  macbook,
  tailnetName,
  machines: Object.fromEntries(
    Object.entries({ studio, devbox, nas, gpu1, gpu2, gpu3 }).map(([name, env]) => [
      name,
      {
        environmentId: env.environmentId,
        label: env.label,
        port: env.serverPort,
        token: token(env),
      },
    ]),
  ),
};
NodeFS.writeFileSync(NodePath.join(out, "stage.json"), JSON.stringify(stage, null, 2));
console.log(`ready: ${NodePath.join(out, "stage.json")}`);

// drive.mjs writes <out>/stop-nas once the browser has seen nas; then it goes offline.
const stopFile = NodePath.join(out, "stop-nas");
NodeFS.rmSync(stopFile, { force: true });
const watcher = setInterval(async () => {
  if (!NodeFS.existsSync(stopFile)) return;
  clearInterval(watcher);
  await nas.stop();
  console.log("nas stopped");
}, 500);
await new Promise(() => {});
