import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

describe("agent-device shim", () => {
  it.effect.skipIf(windowsHost)(
    "runs agent-device as Node when the caller's environment lacks Electron's Node mode",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-device-shim-" });
        // Stands in for the desktop app binary: without Node mode it would start
        // the desktop app, so it aborts like a sandboxed one. It also drops the
        // flag before running, so each hop has to set it again.
        const desktopApp = `${root}/T3 Code`;
        yield* fs.writeFileString(
          desktopApp,
          [
            "#!/bin/sh",
            'if [ "${ELECTRON_RUN_AS_NODE:-}" != "1" ]; then',
            '  echo "started the desktop app" >&2',
            "  exit 134",
            "fi",
            `exec env -u ELECTRON_RUN_AS_NODE '${process.execPath.replaceAll("'", "'\"'\"'")}' "$@"`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(desktopApp, 0o755);
        const entryPath = `${root}/agent-device.mjs`;
        yield* fs.writeFileString(entryPath, 'console.log("agent-device 0.21.23");\n');

        const shimDir = yield* ensureAgentDeviceShim({ entryPath, stateDir: `${root}/state` }).pipe(
          Effect.provideService(HostProcess.ExecutablePath, desktopApp),
          Effect.provideService(HostProcess.IsExecutable, false),
        );

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(`${shimDir}/agent-device`, ["--version"], {
            // What a Codex shell with `inherit = "core"` passes on.
            env: { PATH: process.env.PATH ?? "", HOME: root },
            extendEnv: false,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0, stderr);
        assert.equal(stdout.trim(), "agent-device 0.21.23");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
