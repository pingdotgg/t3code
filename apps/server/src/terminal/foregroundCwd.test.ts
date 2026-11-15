import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePty from "node-pty";

import { foregroundProcessCwd } from "./foregroundCwd.ts";

// A real PTY gives the shell a foreground process group, which procfs reports.
const interactiveBash = Effect.fn("test.interactiveBash")(function* (cwd: string) {
  const shell = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodePty.spawn("bash", ["--norc", "--noprofile", "-i"], {
        cwd,
        cols: 80,
        rows: 24,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "dumb", PS1: "$ " },
      }),
    ),
    (pty) => Effect.sync(() => pty.kill("SIGKILL")),
  );
  let output = "";
  let waiting: { marker: string; done: Deferred.Deferred<void> } | null = null;
  shell.onData((data) => {
    output += data;
    if (waiting && output.includes(waiting.marker)) Deferred.doneUnsafe(waiting.done, Effect.void);
  });
  let count = 0;
  // The marker is split in the typed command, so only the shell's output completes it.
  const run = Effect.fn("test.run")(function* (command: string) {
    count += 1;
    const done = yield* Deferred.make<void>();
    waiting = { marker: `MARK${count}END`, done };
    output = "";
    shell.write(`${command}; echo MARK${count}"END"\r`);
    yield* Deferred.await(done);
  });
  return { pid: shell.pid, run, type: (text: string) => shell.write(text) };
});

describe("foregroundProcessCwd", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "follows the shell and whatever it runs in the foreground",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-foreground-cwd-" });
          yield* fs.makeDirectory(`${root}/sub/deeper`, { recursive: true });
          const shell = yield* interactiveBash(root);
          const cwd = () => foregroundProcessCwd(shell.pid, "linux");

          yield* shell.run("true");
          assert.strictEqual(yield* cwd(), root);
          yield* shell.run("cd sub");
          assert.strictEqual(yield* cwd(), `${root}/sub`);
          // The nested shell holds the terminal, so its directory wins over the outer one.
          shell.type("bash --norc --noprofile -i\r");
          yield* shell.run("cd deeper");
          assert.strictEqual(yield* cwd(), `${root}/sub/deeper`);
          // The outer shell reads the next line once the nested one has given the terminal back.
          shell.type("exit\r");
          yield* shell.run("true");
          assert.strictEqual(yield* cwd(), `${root}/sub`);

          assert.strictEqual(yield* foregroundProcessCwd(shell.pid, "darwin"), null);
          assert.strictEqual(yield* foregroundProcessCwd(shell.pid, "win32"), null);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "has no answer for a process that is gone",
    () =>
      Effect.gen(function* () {
        // Linux caps pids well below 2^31, so this one never exists.
        assert.strictEqual(yield* foregroundProcessCwd(2_147_483_646, "linux"), null);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
