// @effect-diagnostics nodeBuiltinImport:off - Executes the emitted Node launcher with a local spawn fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";

it.effect(
  "sets windowsHide and forwards arguments and exit status in the emitted device launcher",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-shim-" });
      const entryPath = path.join(root, "entry with spaces.mjs");
      const shimDir = yield* ensureAgentDeviceShim({ entryPath, stateDir: root });
      const preload = path.join(root, "spawn-fixture.cjs");
      yield* fs.writeFileString(
        preload,
        `
const { EventEmitter } = require("node:events");
require("node:child_process").spawn = (command, args, options) => {
  console.log(JSON.stringify({ command, args, windowsHide: options.windowsHide, stdio: options.stdio,
    inheritedConfig: options.env.AGENT_DEVICE_CONFIG }));
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", 23));
  return child;
};
require("node:module").syncBuiltinESMExports();
`,
      );
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--require", preload, path.join(shimDir, "agent-device-launcher.mjs"), "--help"],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, AGENT_DEVICE_CONFIG: "fixture-config" },
        },
      );
      assert.isUndefined(result.error);
      assert.equal(result.status, 23);
      assert.deepEqual(JSON.parse(result.stdout), {
        command: process.execPath,
        args: [entryPath, "--help"],
        windowsHide: true,
        stdio: "inherit",
      });
      assert.include(
        yield* fs.readFileString(path.join(shimDir, "agent-device.cmd")),
        "agent-device-launcher.mjs",
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessExecutablePath, process.execPath),
      Effect.provideService(HostProcessIsExecutable, false),
      Effect.provide(NodeServices.layer),
    ),
);
