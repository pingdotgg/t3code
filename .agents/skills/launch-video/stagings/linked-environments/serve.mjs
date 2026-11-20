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
// Generated thread titles go through Claude too; answer them before any scripted turn can.
const title = (text) => ({ match: "title", repeat: true, steps: [{ text }] });
const E2E_OUTPUT = `Running 144 tests using 8 workers

  ✘ checkout.spec.ts:42 › applies a coupon
    Expected: "$18.00"
    Received: "$20.00"
  ✘ avatar.spec.ts:17 › crops on Safari
    Test timeout of 30000ms exceeded.

  2 failed
  142 passed (1.9m)`;
prepareHome(NodePath.join(root, "macbook"), {
  label: "MacBook",
  settings: linked,
  claude: [
    title("Run the e2e suite on devbox"),
    {
      match: "e2e suite on devbox",
      steps: [
        {
          think:
            "The full e2e suite is slow on a laptop. devbox is linked with full access, so I'll run it there.",
        },
        { text: "The full suite takes a while on this laptop, so I'll run it on devbox." },
        {
          tool: "delegate_task",
          input: {
            title: "E2E suite",
            task: "Run the e2e suite on main and report each failing spec with its error.",
            target: { environmentId: "<var:environmentId>", projectId: "<var:projectId>" },
          },
        },
        { text: "Started **E2E suite** on devbox. I'll tell you what fails when it finishes." },
      ],
    },
    {
      steps: [
        {
          text: "The suite finished on devbox: 144 specs ran and 2 failed.\n\n- `checkout.spec.ts` applies a coupon: the 10% coupon is applied after tax, so it charges $20.00 instead of $18.00.\n- `avatar.spec.ts` crops on Safari: times out waiting for the crop preview.\n\nWant me to fix the coupon first?",
        },
      ],
    },
  ],
});
prepareHome(NodePath.join(root, "devbox"), {
  label: "devbox",
  machine: "cloud",
  settings: linked,
  claude: [
    title("E2E suite"),
    {
      match: "e2e suite on main",
      steps: [
        { text: "Installing dependencies, then running all 144 specs on 8 workers." },
        {
          bash: "pnpm install --frozen-lockfile",
          output: "Packages: +1243\nDone in 18.4s",
          ms: 2500,
        },
        { bash: "pnpm build", output: "✓ built in 6.2s", ms: 2500 },
        { bash: "pnpm test:e2e", output: E2E_OUTPUT, ms: 14000 },
        {
          text: "144 specs ran and 2 failed:\n\n- `checkout.spec.ts` applies a coupon: expected **$18.00**, got **$20.00**. The 10% coupon is applied after tax instead of before.\n- `avatar.spec.ts` crops on Safari: timed out after 30s waiting for the crop preview.\n\nThe other 142 passed.",
        },
      ],
    },
    {
      match: "coupon",
      steps: [
        {
          think:
            "The discount is applied to the taxed total. It should come off the subtotal before tax.",
        },
        {
          text: "The coupon is applied after tax in `applyCoupon`. Moving it before tax and rerunning the spec.",
        },
        {
          bash: "pnpm test:e2e checkout.spec.ts",
          output: "  ✓ checkout.spec.ts:42 › applies a coupon\n\n  1 passed (6.1s)",
          ms: 4000,
        },
        { text: "Fixed: the coupon now comes off the subtotal, and `checkout.spec.ts` passes." },
      ],
    },
  ],
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
