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
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { fs, path, entryPath } = input;
  const platform = yield* HostProcessPlatform;
  const shimDir = path.join(input.stateDir, SHIM_DIR);
  yield* fs.makeDirectory(shimDir, { recursive: true });
  const node = process.execPath;
  if (platform === "win32") {
    const script = `@echo off\r\n"${node}" "${entryPath}" %*\r\n`;
    yield* fs.writeFileString(path.join(shimDir, "agent-device.cmd"), script);
  } else {
    const script = `#!/bin/sh\nexec "${node}" "${entryPath}" "$@"\n`;
    const shimPath = path.join(shimDir, "agent-device");
    yield* fs.writeFileString(shimPath, script);
    yield* fs.chmod(shimPath, 0o755);
  }
  return shimDir;
});
