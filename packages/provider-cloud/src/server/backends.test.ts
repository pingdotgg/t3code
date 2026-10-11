import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { makeCodexCloudBackend, type CloudTask } from "./backends.ts";
import { CloudCliError } from "./cli.ts";
import type { CloudCli, CloudCliRequest, CloudCliResult } from "./cli.ts";

/** A CLI that answers each command with the next scripted result and records what ran. */
const scriptedCli = (script: ReadonlyArray<CloudCliResult>) => {
  const calls: Array<CloudCliRequest> = [];
  const cli: CloudCli = (request) =>
    Effect.gen(function* () {
      const next = script[calls.length];
      calls.push(request);
      if (!next) return yield* Effect.die(`unexpected command: ${request.args.join(" ")}`);
      return next;
    });
  return { cli, calls };
};

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const TASK_URL = "https://chatgpt.com/codex/tasks/task_e_123";

const runInput = () => {
  const tasks: Array<CloudTask> = [];
  return {
    tasks,
    input: {
      cwd: "/repo",
      prompt: "--fix the flaky test",
      cloudEnvironment: "my-env",
      onTask: (task: CloudTask) => Effect.sync(() => void tasks.push(task)),
    },
  };
};

describe("Codex Cloud backend", () => {
  it.effect("submits to the id the thread's environment resolves to", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(TASK_URL),
        ok("[READY] Explain\nproject  •  now\nno diff\n"),
      ]);
      const backend = makeCodexCloudBackend({
        cli,
        resolveEnvironment: (id) => {
          assert.equal(id, "selected");
          return Effect.succeed("canonical-id");
        },
      });
      yield* backend.run({ ...runInput().input, cloudEnvironment: "selected" });
      assert.deepStrictEqual(calls[0]?.args, ["cloud", "exec", "--env", "canonical-id", "-"]);
    }),
  );
  it.effect("does not submit a task when destination validation fails", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([]);
      const backend = makeCodexCloudBackend({
        cli,
        resolveEnvironment: () =>
          Effect.fail(new CloudCliError({ detail: "Environment unavailable" })),
      });
      const result = yield* backend
        .run({ ...runInput().input, cloudEnvironment: "deleted" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(calls.length, 0);
    }),
  );

  it.effect("submits, waits for the task, and applies its diff to the workspace", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(`${TASK_URL}\n`),
        { stdout: "[PENDING] Fix flaky test\nmy-env  •  just now\nno diff\n", stderr: "", code: 1 },
        ok("[READY] Fix flaky test\nmy-env  •  just now\n+12/-3\n"),
        ok("Applied patch to 2 files.\n"),
      ]);
      const backend = makeCodexCloudBackend({ cli, pollInterval: 0 });
      const { tasks, input } = runInput();

      const result = yield* backend.run(input);

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["cloud", "exec", "--env", "my-env", "-"],
          ["cloud", "status", "task_e_123"],
          ["cloud", "status", "task_e_123"],
          ["cloud", "apply", "task_e_123"],
        ],
      );
      assert.strictEqual(calls[0]?.stdin, "--fix the flaky test");
      assert.deepStrictEqual(tasks, [{ id: "task_e_123", url: TASK_URL }]);
      assert.include(result.text, "**Fix flaky test** finished in Codex Cloud");
      assert.include(result.text, "(+12/-3) are applied");
    }),
  );

  it.effect("finishes without applying when the task changed nothing", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(TASK_URL),
        ok("[READY] Explain the code\nmy-env  •  just now\nno diff\n"),
      ]);
      const backend = makeCodexCloudBackend({ cli });

      const result = yield* backend.run(runInput().input);

      assert.strictEqual(calls.length, 2);
      assert.include(result.text, "with no changes");
    }),
  );

  it.effect("fails with the task link when the task errors or its diff does not apply", () =>
    Effect.gen(function* () {
      const errored = scriptedCli([
        ok(TASK_URL),
        { stdout: "[ERROR] Broken\n", stderr: "", code: 1 },
      ]);
      const conflict = scriptedCli([
        ok(TASK_URL),
        ok("[READY] Fix\nenv  •  now\n+1/-1\n"),
        { stdout: "Patch failed to apply: conflict in a.ts\n", stderr: "", code: 1 },
      ]);

      const erroredExit = yield* makeCodexCloudBackend({ cli: errored.cli })
        .run(runInput().input)
        .pipe(Effect.exit);
      const conflictExit = yield* makeCodexCloudBackend({ cli: conflict.cli })
        .run(runInput().input)
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(erroredExit));
      assert.include(String(Exit.isFailure(erroredExit) && erroredExit.cause), TASK_URL);
      assert.isTrue(Exit.isFailure(conflictExit));
      assert.include(
        String(Exit.isFailure(conflictExit) && conflictExit.cause),
        "conflict in a.ts",
      );
    }),
  );

  it.effect("refuses to run without an environment", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([]);
      const { cloudEnvironment: _, ...input } = runInput().input;
      const exit = yield* makeCodexCloudBackend({ cli }).run(input).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(calls.length, 0);
    }),
  );
});
