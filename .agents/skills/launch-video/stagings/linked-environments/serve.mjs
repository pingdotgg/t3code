// Two linked environments for the linked-environments video: "MacBook" (server + web client,
// what the viewer drives) and "devbox" (a second server it delegates to). Keeps running; writes
// what drive.mjs needs to <out>/stage.json. Usage: serve.mjs <out-dir>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  REPO,
  cli,
  createProject,
  prepareHome,
  startEnvironment,
} from "../../scripts/stage-env.mjs";

const out = NodePath.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: serve.mjs <out-dir>");
NodeFS.mkdirSync(out, { recursive: true });
const root = NodePath.join(REPO, ".t3/launch/linked-environments");
const vars = NodePath.join(root, "replay-vars.json");

// A linked environment must be another machine: loopback is refused, and plain http is accepted
// only on a tailnet name. Both servers run here, so devbox is reached at this machine's tailnet name.
const tailnetName = JSON.parse(
  NodeChildProcess.execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }),
).Self.DNSName.replace(/\.$/, "");

const linked = { linkedEnvironmentsEnabled: true };
prepareHome(NodePath.join(root, "macbook"), {
  label: "MacBook",
  settings: linked,
  model: "delegate-remote",
});
prepareHome(NodePath.join(root, "devbox"), {
  label: "devbox",
  machine: "cloud",
  settings: linked,
  model: "remote-child",
});
NodeFS.writeFileSync(vars, "{}");

const macbook = await startEnvironment(NodePath.join(root, "macbook"), {
  web: true,
  env: { T3_DEV_REPLAY_VARS: vars },
});
console.log(`MacBook: ${macbook.label} ${macbook.environmentId} web ${macbook.webOrigin}`);
const devbox = await startEnvironment(NodePath.join(root, "devbox"), {
  host: "0.0.0.0",
  allowedOrigins: [macbook.webOrigin],
});
console.log(`devbox: ${devbox.label} ${devbox.environmentId}`);

const devboxProject = await createProject(devbox, "mugshot", { "README.md": "# mugshot\n" });
const macbookProject = await createProject(macbook, "mugshot", { "README.md": "# mugshot\n" });

const pairing = cli(devbox.home, ["pair", "--label", "MacBook"]);
const code = /pairingToken[=:]\s*([A-Za-z0-9_-]+)|token=([A-Za-z0-9_-]+)/.exec(pairing);
if (!code)
  throw new Error(
    `could not read a pairing code from:\n${pairing.replace(/[A-Za-z0-9_-]{20,}/g, "<redacted>")}`,
  );
console.log(
  cli(macbook.home, [
    "environment",
    "link",
    `http://${tailnetName}:${devbox.serverPort}`,
    "--pairing-code",
    code[1] ?? code[2],
    "--access",
    "full-access",
  ]).trim(),
);

NodeFS.writeFileSync(
  vars,
  JSON.stringify({ environmentId: devbox.environmentId, projectId: devboxProject.projectId }),
);
NodeFS.writeFileSync(
  NodePath.join(out, "stage.json"),
  JSON.stringify({ macbook, devbox, macbookProject, devboxProject }, null, 2),
);
console.log(`ready: ${NodePath.join(out, "stage.json")}`);
await new Promise(() => {});
