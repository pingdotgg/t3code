#!/usr/bin/env node
// Writes src/generated.rs: what the T3 server runs on a device host or hands an agent, taken
// from apps/server/src/device and the device toolkit so it stays byte for byte equal.
//
// - The tool pins (`deviceToolVersions.json`).
// - The SSH host bootstrap: the shell prelude and the Node script (`sshDeviceScript.ts`),
//   with the owner and the mode as placeholders.
// - The agent-device launcher and its shell wrapper (`AgentDeviceShim.ts`), written by T3's
//   own `bindAgentDeviceLauncher` with placeholders for Node, the entry and the bound flags.
// - The default-display screenshot script (`DeviceHubOperations.ts`).
//
// Also writes testdata/quickstart.json: what `agentDeviceQuickStart` and the agent-device
// session name return for a few inputs, which the Rust tests compare with their own build.
//
//   node crates/conn-devices/tools/gen-devices.mjs [--check]
//
// `--check` exits 1 when a file is out of date.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { importSource, inMonorepo, packageImporter } from "../../../tools/monorepo.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const CRATE = NodePath.dirname(HERE);
const check = process.argv.includes("--check");

const fromServer = packageImporter("apps/server");
const Effect = await fromServer("effect/Effect");
const Layer = await fromServer("effect/Layer");
const NodeServices = await fromServer("@effect/platform-node/NodeServices");
const HostProcess = await importSource("packages/shared/src/HostProcess.ts");

const versions = JSON.parse(
  NodeFS.readFileSync(inMonorepo("apps/server/src/device/deviceToolVersions.json"), "utf8"),
);
const script = await importSource("apps/server/src/device/sshDeviceScript.ts");
const shim = await importSource("apps/server/src/device/AgentDeviceShim.ts");
const handlers = await importSource("apps/server/src/mcp/toolkits/device/handlers.ts");
const target = await importSource("apps/server/src/device/AgentDeviceTarget.ts");

const OWNER = "@@OWNER@@";
const MODE = "@@MODE@@";
const NODE = "/@@NODE@@";
const ENTRY = "/@@ENTRY@@";
const BOUND = "@@BOUND@@";

/** `text` with exactly `count` copies of `needle`; anything else means upstream changed shape. */
function expectCount(text, needle, count, what) {
  const found = text.split(needle).length - 1;
  if (found !== count) {
    console.error(`${what}: expected ${count} of ${JSON.stringify(needle)}, found ${found}`);
    process.exit(1);
  }
  return text;
}

const remoteScript = expectCount(
  expectCount(script.remoteDeviceScript(OWNER, MODE), JSON.stringify(OWNER), 1, "remote script"),
  JSON.stringify(MODE),
  1,
  "remote script",
);

// T3's own launcher writer, in a scratch folder, as a desktop app without its own Node would.
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-devices-gen-"));
let launcherScript;
let launcherSource;
try {
  const written = await Effect.runPromise(
    shim
      .bindAgentDeviceLauncher({
        entryPath: ENTRY,
        stateDir: scratch,
        session: "s",
        targetArgs: [BOUND],
      })
      .pipe(
        Effect.provideService(HostProcess.ExecutablePath, NODE),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(Layer.mergeAll(NodeServices.layer)),
      ),
  );
  launcherScript = NodeFS.readFileSync(written, "utf8");
  launcherSource = NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(written), "agent-device-launcher.mjs"),
    "utf8",
  );
} finally {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
}
const launcherPathInScript = NodePath.join(scratch, "device/targets/s/agent-device-launcher.mjs");
launcherScript = expectCount(launcherScript, launcherPathInScript, 1, "launcher script").replace(
  launcherPathInScript,
  "/@@LAUNCHER@@",
);
expectCount(launcherScript, `'${NODE}'`, 2, "launcher script");
expectCount(launcherSource, JSON.stringify(NODE), 1, "launcher source");
expectCount(launcherSource, JSON.stringify(ENTRY), 1, "launcher source");
expectCount(launcherSource, JSON.stringify([BOUND]), 1, "launcher source");

const hubOperations = NodeFS.readFileSync(
  inMonorepo("apps/server/src/device/DeviceHubOperations.ts"),
  "utf8",
);
const screenshotMatch = /const DEFAULT_DISPLAY_SCREENSHOT = `([^`]*)`;/.exec(hubOperations);
if (!screenshotMatch) {
  console.error("DeviceHubOperations.ts: DEFAULT_DISPLAY_SCREENSHOT not found");
  process.exit(1);
}

// The hub proxy's allow-lists and the request headers it drops (`DeviceHubProxy.ts`).
const proxySource = NodeFS.readFileSync(inMonorepo("apps/server/src/device/DeviceHubProxy.ts"), "utf8");
function regexList(name) {
  const block = new RegExp(`const ${name}: ReadonlyArray<RegExp> = \\[([\\s\\S]*?)\\n\\];`).exec(proxySource);
  if (!block) {
    console.error(`DeviceHubProxy.ts: ${name} not found`);
    process.exit(1);
  }
  const patterns = block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/") && !line.startsWith("//"))
    .map((line) => {
      const match = /^\/(.*)\/,?$/.exec(line);
      if (!match) {
        console.error(`DeviceHubProxy.ts: ${name} has an entry this generator cannot read: ${line}`);
        process.exit(1);
      }
      return match[1].replaceAll("\\/", "/");
    });
  if (patterns.length === 0) {
    console.error(`DeviceHubProxy.ts: ${name} is empty`);
    process.exit(1);
  }
  return patterns;
}
const droppedBlock = /const DROPPED_REQUEST_HEADERS = new Set\(\[([\s\S]*?)\]\);/.exec(proxySource);
if (!droppedBlock) {
  console.error("DeviceHubProxy.ts: DROPPED_REQUEST_HEADERS not found");
  process.exit(1);
}
const droppedHeaders = [...droppedBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const rustList = (items) => `&[\n${items.map((item) => `    ${raw(item)},`).join("\n")}\n]`;

/** A Rust raw string literal that holds `text` unchanged. */
const raw = (text) => {
  let hashes = "#";
  while (text.includes(`"${hashes}`)) hashes += "#";
  return `r${hashes}"${text}"${hashes}`;
};

const rust = `// @generated by tools/gen-devices.mjs from the Conn monorepo. Do not edit.
// Regenerate: node crates/conn-devices/tools/gen-devices.mjs

/// \`deviceToolVersions.json\`: the agent-device pin.
pub const AGENT_DEVICE_VERSION: &str = ${JSON.stringify(versions["agent-device"])};
/// \`deviceToolVersions.json\`: the expo-device-hub pin.
pub const DEVICE_HUB_VERSION: &str = ${JSON.stringify(versions["expo-device-hub"])};

/// \`remoteDeviceEnvironment\` (\`sshDeviceScript.ts\`): PATH and SDK setup before every
/// remote command.
pub const REMOTE_ENVIRONMENT: &str = ${raw(script.remoteDeviceEnvironment)};

/// \`remoteDeviceScript(owner, mode)\` with \`"${OWNER}"\` and \`"${MODE}"\` in place of the
/// JSON-quoted owner and mode.
pub const REMOTE_SCRIPT: &str = ${raw(remoteScript)};

/// The agent-device launcher (\`agent-device-launcher.mjs\`) with \`"${NODE}"\`,
/// \`"${ENTRY}"\` and \`["${BOUND}"]\` in place of the JSON-quoted Node path, entry path and
/// bound flags.
pub const LAUNCHER_SOURCE: &str = ${raw(launcherSource)};

/// The launcher's shell wrapper (\`agent-device\`) with \`'${NODE}'\` and
/// \`'/@@LAUNCHER@@'\` in place of the shell-quoted Node and launcher paths.
pub const LAUNCHER_SCRIPT: &str = ${raw(launcherScript)};

/// \`DEFAULT_DISPLAY_SCREENSHOT\` (\`DeviceHubOperations.ts\`).
pub const DEFAULT_DISPLAY_SCREENSHOT: &str = ${raw(screenshotMatch[1])};

/// \`ALLOWED_PATHS\` (\`DeviceHubProxy.ts\`): hub paths that take GET.
pub const HUB_ALLOWED_PATHS: &[&str] = ${rustList(regexList("ALLOWED_PATHS"))};

/// \`MUTABLE_PATHS\`: hub paths that take methods besides GET.
pub const HUB_MUTABLE_PATHS: &[&str] = ${rustList(regexList("MUTABLE_PATHS"))};

/// \`ALLOWED_WS_PATHS\`: hub paths a WebSocket may open.
pub const HUB_WS_PATHS: &[&str] = ${rustList(regexList("ALLOWED_WS_PATHS"))};

/// \`DROPPED_REQUEST_HEADERS\`: request headers the proxy never forwards.
pub const HUB_DROPPED_REQUEST_HEADERS: &[&str] = ${rustList(droppedHeaders)};
`;

// Cases for the Rust build of the quick start and the session names.
const device = (platform, extra = {}) => ({
  hostId: "local",
  id: platform === "ios" ? "11111111-2222-3333-4444-555555555555" : "emulator-5554",
  platform,
  name: platform === "ios" ? "iPhone 17 Pro" : "Pixel 9",
  version: platform === "ios" ? "iOS 26.0" : "Android 16",
  booted: true,
  physical: false,
  ...extra,
});
const quickStarts = [
  { device: device("ios"), command: "/state/device/targets/t3-abc/agent-device" },
  { device: device("android"), command: "/state/device/targets/t3-abc/agent-device" },
  { device: device("ios", { name: "iPad's \"Air\"" }), command: "/a path/with spaces/agent-device" },
].map((c) => ({ ...c, text: handlers.agentDeviceQuickStart(c.device, [], c.command) }));
const sessions = await Promise.all(
  [
    ["thread-1", "local", "11111111-2222-3333-4444-555555555555"],
    ["thread:β", "mac", "emulator-5554"],
  ].map(async ([threadId, hostId, deviceId]) => ({
    threadId,
    hostId,
    deviceId,
    session: await Effect.runPromise(
      target
        .agentDeviceSession(threadId, hostId, deviceId)
        .pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, await nodeCrypto()))),
    ),
  })),
);
async function nodeCrypto() {
  return (await fromServer("@effect/platform-node/NodeCrypto")).layer;
}
const json = `${JSON.stringify({ quickStarts, sessions }, null, 1)}\n`;

const outputs = [
  [NodePath.join(CRATE, "src/generated.rs"), rust],
  [NodePath.join(CRATE, "testdata/quickstart.json"), json],
];
let stale = 0;
for (const [file, content] of outputs) {
  const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : undefined;
  if (current === content) continue;
  if (check) {
    console.error(`${NodePath.relative(CRATE, file)} is out of date: run tools/gen-devices.mjs`);
    stale += 1;
  } else {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
    console.log(`wrote ${NodePath.relative(CRATE, file)}`);
  }
}
if (check && stale === 0) console.log("device texts current");
process.exit(stale === 0 ? 0 : 1);
