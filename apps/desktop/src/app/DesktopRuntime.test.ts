// @effect-diagnostics-next-line nodeBuiltinImport:off - A real Node process verifies OS signal ownership outside Effect's process runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";

it("leaves SIGTERM to the lifecycle until its graceful shutdown completes", async ({
  onTestFinished,
}) => {
  const runner = new URL("./DesktopRuntime.ts", import.meta.url).href;
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    import * as Effect from 'effect/Effect';
    import * as Deferred from 'effect/Deferred';
    import { runMain } from ${JSON.stringify(runner)};
    let released = false;
    runMain(Effect.scoped(Effect.gen(function* () {
      const done = yield* Deferred.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log(released ? 'CLEANED' : 'PREMATURE')));
      process.once('SIGTERM', () => {
        console.log('STOPPING');
        process.stdin.once('data', () => {
          released = true;
          void Effect.runPromise(Deferred.succeed(done, undefined)).then(() => process.stdin.destroy());
        });
      });
      console.log('READY');
      yield* Deferred.await(done);
    })));
  `,
    ],
    {
      cwd: NodeURL.fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<readonly [number | null, string | null]>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
    child.once("error", reject);
  });
  const lines: string[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  for await (const line of NodeReadline.createInterface({ input: child.stdout })) {
    lines.push(line);
    if (line === "READY") child.kill("SIGTERM");
    if (line === "STOPPING") child.stdin.write("finish");
  }
  expect(await exited, stderr).toEqual([0, null]);
  expect(lines).toEqual(["READY", "STOPPING", "CLEANED"]);
});
