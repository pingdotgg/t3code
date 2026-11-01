import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ensureTailscaleServe } from "./tailscale.ts";

// A stand-in for a hung `tailscale` CLI: reports its pid, swallows SIGTERM, and
// keeps running. A wedged real daemon behaves the same way, which is why the
// probe path escalates to SIGKILL.
const HUNG_TAILSCALE_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
try {
  fs.writeFileSync(process.env.TAILSCALE_STUB_PID_FILE, String(process.pid));
} catch {}
process.on("SIGTERM", () => {
  // Hung: a wedged CLI does not exit on SIGTERM.
});
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

it.layer(NodeServices.layer)("tailscale serve kill repro", (it) => {
  it.effect("escalates a hung serve command to SIGKILL", () =>
    Effect.gen(function* () {
      // The gap is POSIX-only: the Windows spawner's taskkill /F already
      // force-kills the group, so a leak can only be demonstrated where SIGTERM
      // must be escalated. The Platform reference's narrower type hides win32,
      // but its default is the real process platform, hence the string cast.
      const platform: string = yield* HostProcess.Platform;
      if (platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stubDir = yield* fs.makeTempDirectory();
      const pidFile = path.join(stubDir, "stub.pid");
      const stubPath = path.join(stubDir, "tailscale");
      yield* fs.writeFileString(stubPath, HUNG_TAILSCALE_STUB);
      yield* fs.chmod(stubPath, 0o755);
      process.env.TAILSCALE_STUB_PID_FILE = pidFile;
      process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;

      // Interrupting the serve call runs the spawner's cleanup: SIGTERM to the
      // process group, then — with forceKillAfter — SIGKILL after the grace.
      const outcome = yield* ensureTailscaleServe({ localPort: 45_678 }).pipe(
        Effect.timeout("3 seconds"),
        Effect.result,
        Effect.ensuring(
          Effect.gen(function* () {
            const text = yield* fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => ""));
            const pid = Number.parseInt(text, 10);
            if (Number.isInteger(pid)) {
              yield* Effect.try(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore);
            }
            yield* fs.remove(stubDir, { recursive: true }).pipe(Effect.ignore);
          }),
        ),
      );
      assert.isTrue(Result.isFailure(outcome), "the interrupted serve call must fail");

      const pid = Number.parseInt(yield* fs.readFileString(pidFile), 10);
      assert.isTrue(Number.isInteger(pid), "the stub must have reported its pid");

      // Without the escalation the SIGTERM-ignoring process outlives the call.
      yield* Effect.promise(() =>
        expect.poll(() => isAlive(pid), { interval: 200, timeout: 4_000 }).toBe(false),
      );
    }),
  );
});
