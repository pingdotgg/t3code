import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ensureTailscaleServe } from "./tailscale.ts";

// A hung CLI must survive SIGTERM before reporting readiness.
const HUNG_TAILSCALE_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.TAILSCALE_STUB_PID_FILE, String(process.pid));
setInterval(() => {}, 60_000);
`;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.live("escalates a hung serve command to SIGKILL", () =>
  Effect.gen(function* () {
    // Windows already uses taskkill /F for process cleanup.
    const platform: string = yield* HostProcess.Platform;
    if (platform === "win32") return;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stubDir = yield* fs.makeTempDirectoryScoped();
    const pidFile = path.join(stubDir, "stub.pid");
    const stubPath = path.join(stubDir, "tailscale");
    yield* fs.writeFileString(stubPath, HUNG_TAILSCALE_STUB);
    yield* fs.chmod(stubPath, 0o755);
    const originalPath = process.env.PATH;
    const originalPidFile = process.env.TAILSCALE_STUB_PID_FILE;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalPidFile === undefined) delete process.env.TAILSCALE_STUB_PID_FILE;
        else process.env.TAILSCALE_STUB_PID_FILE = originalPidFile;
        const text = yield* fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => ""));
        const pid = Number.parseInt(text, 10);
        if (Number.isInteger(pid)) {
          yield* Effect.try(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore);
        }
      }),
    );
    process.env.TAILSCALE_STUB_PID_FILE = pidFile;
    process.env.PATH = `${stubDir}:${originalPath ?? ""}`;

    const outcome = yield* ensureTailscaleServe({ localPort: 45_678 }).pipe(
      Effect.timeout("3 seconds"),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(outcome), "the interrupted serve call must fail");
    if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "TimeoutError");

    const pid = Number.parseInt(yield* fs.readFileString(pidFile), 10);
    assert.isTrue(Number.isInteger(pid), "the stub must have reported its pid");
    assert.isFalse(isAlive(pid), "serve cleanup must reap the stub before returning");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
