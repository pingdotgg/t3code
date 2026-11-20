#!/usr/bin/env node
// `environment link-orbit` against a stand-in Orbit Gateway on loopback: T3's command (`t3
// environment link-orbit`, `OrbitEnvironmentLink.ts`) and ours take the same cases and must
// print the same, after ids, addresses and times are replaced by placeholders. The stand-in
// answers `/api/v1/conn/environments` and the pairing calls as Orbit does (docs/reference/conn.md
// in Orbit): a pairing link at once, or an Operation to follow. It mints each code from the
// target server's own `/api/auth/pairing-token`, as Orbit's session there does. Both servers
// refuse to send a code Orbit handed out to a loopback address (`answeringAs`: loopback is this
// machine), so the cases that pair end there; a link that succeeds needs a WireGuard or
// Tailscale address. No model is called; the Gateway and every server listen on loopback.
// Usage: orbit-link-diff.mjs <conn-server binary (replay_server)>. Needs `vp i` in the monorepo.
import * as NodeHttp from "node:http";

import { updateSettings } from "../../conn-mcp/tools/handoff-fixture.mjs";
import { monorepo } from "../../../tools/monorepo.mjs";
import { peerFixture } from "./peer-fixture.mjs";

const rustBinary = process.argv[2];
if (rustBinary === undefined) {
  console.error("usage: orbit-link-diff.mjs <conn-server binary>");
  process.exit(2);
}
monorepo();

const { startTs, startRust, rpc, post, descriptor, normalize } = peerFixture(rustBinary, "conn-orbit-link-");

// The stand-in Gateway. `gateway.answer(method, path)` gives `[status, body]` for the case.
const gateway = { answer: () => [500, {}], minted: 0 };
const server = NodeHttp.createServer(async (request, response) => {
  const [status, body] = await gateway.answer(request.method, request.url);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
process.once("exit", () => server.close());

const [ta, ca, tb, cb, off] = await Promise.all([
  startTs("ta"),
  startRust("ca"),
  startTs("tb"),
  startRust("cb"),
  startRust("off"),
]);
for (const s of [ta, ca, tb, cb, off]) {
  const d = await descriptor(s);
  s.id = d.environmentId;
  s.label = d.label;
}
await updateSettings(off, { linkedEnvironmentsEnabled: false });

let failed = 0;
const report = (line, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "DIFF"} ${line}${ok || detail === "" ? "" : `\n       ${detail}`}`);
};

const listed = (target, overrides = {}) => ({
  environment_id: target.id, label: target.label, url: target.origin, status: "registered",
  server_version: "0.0.0", registered_by: "node", registered_at: "2026-11-20T00:00:00Z",
  instance_id: null, power_state: null, ...overrides,
});
const mint = async (target) => {
  gateway.minted++;
  const code = (await post(target, "/api/auth/pairing-token", { label: "Orbit" }))
    .credential;
  return { pairing_url: `${target.origin}/pair#token=${code}`, pairing: { environment_id: target.id, expires_at: "2026-11-20T01:00:00Z" } };
};
const error = (status, code, details = {}) => [status, { error: { code, message: "Gateway text that never shows.", details } }];

/** The cases, each `[name, environment id asked for, answer(method, path, target)]`. */
const cases = (target) => [
  ["the Gateway does not answer", target.id, "down"],
  ["this Node has no access", target.id, (m, p) => (p.endsWith("/environments") ? error(403, "node_access.required") : error(500, "x"))],
  ["Orbit lists no such environment", "environment:missing", (m, p) => [200, { data: [listed(target)] }]],
  ["an answer that is no list", target.id, (m, p) => [200, { data: { nope: true } }]],
  ["the session there expired", target.id, (m, p) => [200, { data: [listed(target, { status: "session_expired" })] }]],
  [
    "Orbit refuses the pairing",
    target.id,
    (m, p) => (p.endsWith("/environments") ? [200, { data: [listed(target)] }] : error(409, "conn.request_refused")),
  ],
  [
    "the pairing Operation fails",
    target.id,
    (m, p) =>
      p.endsWith("/environments")
        ? [200, { data: [listed(target)] }]
        : m === "POST"
          ? [202, { data: { id: 41, kind: "conn.pairing", status: "running", poll_after_seconds: 0 } }]
          : [200, { data: { id: 41, kind: "conn.pairing", status: "failed", error_code: "conn.session_rejected" } }],
  ],
  [
    "a pairing link without a code",
    target.id,
    (m, p) =>
      p.endsWith("/environments")
        ? [200, { data: [listed(target)] }]
        : [200, { data: { pairing_url: `${target.origin}/pair`, pairing: { environment_id: target.id, expires_at: "x" } } }],
  ],
  [
    "the address answers as another environment",
    "environment:elsewhere",
    async (m, p) =>
      p.endsWith("/environments")
        ? [200, { data: [listed(target, { environment_id: "environment:elsewhere", label: "Elsewhere" })] }]
        : [200, { data: { ...(await mint(target)), pairing: { environment_id: "environment:elsewhere", expires_at: "x" } } }],
  ],
  [
    "the pairing Operation, then the link (loopback is refused)",
    target.id,
    async (m, p) =>
      p.endsWith("/environments")
        ? [200, { data: [listed(target)] }]
        : m === "POST"
          ? [202, { data: { id: 42, kind: "conn.pairing", status: "queued", poll_after_seconds: 0 } }]
          : p.endsWith("/operations/42")
            ? [200, { data: { id: 42, kind: "conn.pairing", status: "succeeded", result: { pairing_id: 7 } } }]
            : [200, { data: await mint(target) }],
  ],
  [
    "a pairing link at once, with full access (loopback is refused)",
    target.id,
    async (m, p) => (p.endsWith("/environments") ? [200, { data: [listed(target)] }] : [200, { data: await mint(target) }]),
    ["--access", "full-access"],
  ],
  [
    "links off there (loopback is refused first)",
    off.id,
    async (m, p) => (p.endsWith("/environments") ? [200, { data: [listed(off)] }] : [200, { data: await mint(off) }]),
  ],
];

/** Runs every case from `a` to `target`; returns case name → printed answer. */
async function run(a, target) {
  const names = [
    [target.origin, "<B-url>"],
    [off.origin, "<off-url>"],
    [target.id, "<B>"],
    [off.id, "<off>"],
    [target.label, "<label>"],
    [a.label, "<label>"],
  ];
  const out = new Map();
  for (const [name, environment, answer, extra = []] of cases(target)) {
    gateway.answer = answer === "down" ? () => [500, {}] : answer;
    const url = answer === "down" ? "http://127.0.0.1:9" : gatewayUrl;
    const result = await a.cli(["environment", "link-orbit", environment, "--gateway-url", url, ...extra]);
    // The code and message lead stderr, as scripts read them. On a failure T3 also logs the
    // error with its stack, which is not compared; on success stdout is.
    const failure = (result.stderr ?? "").split("\n").find((line) => /^[a-z_]+: /.test(line)) ?? null;
    out.set(
      name,
      normalize({ exit: result.status, stdout: result.status === 0 ? result.stdout : null, failure }, names),
    );
  }
  const links = await rpc(a, "peerLinks.list", {});
  out.set(
    "the link afterwards",
    normalize(
      (Array.isArray(links.value) ? links.value : (links.value?.links ?? [])).map((l) => ({ environmentId: l.environmentId, label: l.label, access: l.access, status: l.status })),
      names,
    ),
  );
  await rpc(a, "peerLinks.unlink", { environmentId: target.id });
  await updateSettings(a, { linkedEnvironmentsEnabled: false });
  gateway.answer = () => [200, { data: [listed(target)] }];
  const offHere = await a.cli(["environment", "link-orbit", target.id, "--gateway-url", gatewayUrl]);
  out.set(
    "links are off here",
    normalize({ exit: offHere.status, failure: (offHere.stderr ?? "").split("\n").find((l) => /^[a-z_]+: /.test(l)) ?? null }, names),
  );
  await updateSettings(a, { linkedEnvironmentsEnabled: true });
  return out;
}

const reference = await run(ta, tb);
if (process.argv.includes("--show")) for (const [step, value] of reference) console.log(`T3 → T3 ${step}: ${value}`);
for (const [label, a, b] of [
  ["Conn → Conn", ca, cb],
  ["Conn → T3", ca, tb],
  ["T3 → Conn", ta, cb],
]) {
  const answers = await run(a, b);
  for (const [step, expected] of reference) {
    const got = answers.get(step);
    report(`${label}: ${step}`, got === expected, `T3 → T3: ${expected}\n       ${label}: ${got}`);
  }
}
console.log(failed === 0 ? "\norbit link: no differences" : `\norbit link: ${failed} differences`);
process.exit(failed === 0 ? 0 : 1);
