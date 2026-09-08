// @effect-diagnostics preferSchemaOverJson:off - JSON string literals embed paths safely into generated JavaScript.
/**
 * A directory holding an `agent-device` launcher that runs the pinned install
 * with the server's Node. Prepended to provider subprocess PATHs so the agent
 * types `agent-device …` and gets the version the injected instructions were
 * written for, regardless of what is or is not globally installed.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SHIM_DIR = "device/bin";

export const ensureAgentDeviceShim = Effect.fn("AgentDeviceShim.ensure")(function* (input: {
  readonly entryPath: string;
  readonly stateDir: string;
}) {
  const { entryPath } = input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const shimDir = path.join(input.stateDir, SHIM_DIR);
  yield* fs.makeDirectory(shimDir, { recursive: true });
  const node = process.execPath;
  const launcherPath = path.join(shimDir, "agent-device-launcher.mjs");
  yield* fs.writeFileString(
    launcherPath,
    `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (!args.includes("--config") && !args.some(arg => ["help", "--help", "-h", "--version", "version"].includes(arg))) {
  console.error("Call device_open first and include its --config and --session flags.");
  process.exit(1);
}
const env = { ...process.env };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(node)}, [${JSON.stringify(entryPath)}, ...args], { stdio: "inherit", env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`,
  );
  if (platform === "win32") {
    const script = `@echo off\r\n"${node}" "${launcherPath}" %*\r\n`;
    yield* fs.writeFileString(path.join(shimDir, "agent-device.cmd"), script);
  } else {
    const script = `#!/bin/sh\nexec "${node}" "${launcherPath}" "$@"\n`;
    const shimPath = path.join(shimDir, "agent-device");
    yield* fs.writeFileString(shimPath, script);
    yield* fs.chmod(shimPath, 0o755);
  }
  return shimDir;
});
