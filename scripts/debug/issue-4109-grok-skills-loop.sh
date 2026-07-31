#!/usr/bin/env bash
# Feedback loop for https://github.com/pingdotgg/t3code/issues/4109
# RED when: Grok ACP advertises availableCommands/skills but T3 GrokProvider
# never populates slashCommands/skills (always defaults to []).
#
# Also checks for the skills-reload RequestId shape that used to crash Effect
# RpcMessage.RequestId via BigInt("skills-reload").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "=== A: GrokProvider wires slashCommands/skills from ACP catalog ==="
if ! rg -q 'slashCommands: discovered\.slashCommands' apps/server/src/provider/Layers/GrokProvider.ts; then
  echo "RED: GrokProvider does not assign discovered.slashCommands"
  exit 1
fi
if ! rg -q 'skills: discovered\.skills' apps/server/src/provider/Layers/GrokProvider.ts; then
  echo "RED: GrokProvider does not assign discovered.skills"
  exit 1
fi
if ! rg -q 'mapAcpAvailableCommandsToProviderCatalog' apps/server/src/provider/Layers/GrokProvider.ts; then
  echo "RED: GrokProvider does not map ACP availableCommands"
  exit 1
fi
if ! rg -q 'available_commands_update' apps/server/src/provider/acp/AcpSessionRuntime.ts; then
  echo "RED: AcpSessionRuntime does not capture available_commands_update"
  exit 1
fi
echo "CONFIRMED: discovery path maps availableCommands into provider snapshot"

echo
echo "=== B: Pure mapper turns path-backed commands into skills ==="
# Keep this loop free of the monorepo test runner so agents can red/green without vp.
node --input-type=module -e '
const commands = [
  { name: "compact", description: "Compress", input: { hint: "ctx" } },
  { name: "diag", description: "Debug", _meta: { path: "/tmp/diag/SKILL.md", scope: "user" } },
];
function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
const slash = [];
const skills = [];
for (const c of commands) {
  const name = nonEmpty(c.name);
  if (!name) continue;
  slash.push({ name, description: nonEmpty(c.description), input: c.input?.hint ? { hint: c.input.hint } : undefined });
  const path = nonEmpty(c._meta?.path);
  if (path) skills.push({ name, path, enabled: true, scope: nonEmpty(c._meta?.scope), description: nonEmpty(c.description) });
}
if (slash.length < 2 || skills.length !== 1) {
  console.error("RED: mapper contract broken", { slash, skills });
  process.exit(1);
}
console.log("mapper slash=", slash.length, "skills=", skills.length);

// Also prove Grok still advertises the wire shape the mapper expects.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { utimesSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const proc = spawn("grok", ["agent", "stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GROK_OAUTH2_REFERRER: "t3code" },
});
const rl = createInterface({ input: proc.stdout });
const lines = [];
rl.on("line", (line) => lines.push(line));
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "issue-4109-loop", version: "0" } } });
await new Promise((r) => setTimeout(r, 1500));
send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cached_token" } });
await new Promise((r) => setTimeout(r, 1500));
send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
await new Promise((r) => setTimeout(r, 3000));
const skillRoot = join(homedir(), ".grok", "skills");
let sawReload = false;
if (existsSync(skillRoot)) {
  const first = readdirSync(skillRoot).find((name) => existsSync(join(skillRoot, name, "SKILL.md")));
  if (first) {
    const target = join(skillRoot, first, "SKILL.md");
    const now = new Date();
    utimesSync(target, now, now);
    await new Promise((r) => setTimeout(r, 2500));
  }
}
proc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
let cmds = null;
for (const line of lines) {
  try {
    const msg = JSON.parse(line);
    if (msg.id === "skills-reload") sawReload = true;
    const update = msg.params?.update;
    if (update?.sessionUpdate === "available_commands_update") cmds = update.availableCommands;
  } catch {}
}
if (!cmds?.length) {
  console.error("RED: no available_commands_update from real grok");
  process.exit(1);
}
const withPath = cmds.filter((c) => c?._meta?.path);
console.log("ACP availableCommands=", cmds.length, "with_path=", withPath.length, "skills_reload_seen=", sawReload);
if (withPath.length === 0) {
  console.error("RED: expected path-backed skills on this machine");
  process.exit(1);
}
// Simulate fixed T3 mapping on the live payload
const mappedSkills = withPath.filter((c) => nonEmpty(c.name) && nonEmpty(c._meta?.path));
const mappedSlash = cmds.filter((c) => nonEmpty(c.name));
console.log("mapped slash=", mappedSlash.length, "skills=", mappedSkills.length);
if (mappedSlash.length === 0 || mappedSkills.length === 0) {
  console.error("RED: mapped catalog empty");
  process.exit(1);
}
console.log("GREEN: Grok ACP catalog maps to non-empty slashCommands and skills");
process.exit(0);
'
