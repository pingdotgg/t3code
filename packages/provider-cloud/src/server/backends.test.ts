import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { makeClaudeCloudBackend, makeCodexCloudBackend, type CloudTask } from "./backends.ts";
import type { CloudCli, CloudCliRequest, CloudCliResult } from "./cli.ts";

/** A CLI that answers each command with the next scripted result and records what ran. */
const scriptedCli = (
  script: ReadonlyArray<CloudCliResult & { readonly stderrLines?: ReadonlyArray<string> }>,
) => {
  const calls: Array<CloudCliRequest> = [];
  const cli: CloudCli = (request) =>
    Effect.gen(function* () {
      const next = script[calls.length];
      calls.push(request);
      if (!next) return yield* Effect.die(`unexpected command: ${request.args.join(" ")}`);
      for (const line of next.stderrLines ?? []) yield* request.onStderrLine?.(line) ?? Effect.void;
      return next;
    });
  return { cli, calls };
};

const ok = (stdout: string, stderrLines?: ReadonlyArray<string>) => ({
  stdout,
  stderr: "",
  code: 0,
  ...(stderrLines ? { stderrLines } : {}),
});
const TASK_URL = "https://chatgpt.com/codex/tasks/task_e_123";

const runInput = (session?: string) => {
  const tasks: Array<CloudTask> = [];
  return {
    tasks,
    input: {
      cwd: "/repo",
      prompt: "--fix the flaky test",
      session,
      onTask: (task: CloudTask) => Effect.sync(() => void tasks.push(task)),
    },
  };
};

describe("Codex Cloud backend", () => {
  it.effect("submits, waits for the task, and applies its diff to the workspace", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(`${TASK_URL}\n`),
        { stdout: "[PENDING] Fix flaky test\nmy-env  •  just now\nno diff\n", stderr: "", code: 1 },
        ok("[READY] Fix flaky test\nmy-env  •  just now\n+12/-3\n"),
        ok("Applied patch to 2 files.\n"),
      ]);
      const backend = makeCodexCloudBackend({ cli, environment: "my-env", pollInterval: 0 });
      const { tasks, input } = runInput();

      const result = yield* backend.run(input);

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["cloud", "exec", "--env", "my-env", "--", "--fix the flaky test"],
          ["cloud", "status", "task_e_123"],
          ["cloud", "status", "task_e_123"],
          ["cloud", "apply", "task_e_123"],
        ],
      );
      assert.deepStrictEqual(tasks, [{ id: "task_e_123", url: TASK_URL }]);
      assert.include(result.text, "**Fix flaky test** finished in Codex Cloud");
      assert.include(result.text, "(+12/-3) are applied");
      assert.isUndefined(result.session);
    }),
  );

  it.effect("finishes without applying when the task changed nothing", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(TASK_URL),
        ok("[READY] Explain the code\nmy-env  •  just now\nno diff\n"),
      ]);
      const backend = makeCodexCloudBackend({ cli, environment: "my-env" });

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

      const erroredExit = yield* makeCodexCloudBackend({ cli: errored.cli, environment: "e" })
        .run(runInput().input)
        .pipe(Effect.exit);
      const conflictExit = yield* makeCodexCloudBackend({ cli: conflict.cli, environment: "e" })
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
      const exit = yield* makeCodexCloudBackend({ cli, environment: "" })
        .run(runInput().input)
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(calls.length, 0);
    }),
  );
});

describe("Claude Code Cloud backend", () => {
  const SESSION_URL = "https://claude.ai/code/session_01abc";

  it.effect("creates a session from stdin and returns the cloud reply", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "Fixed the flaky test.",
            session_id: "session_01abc",
            session_url: SESSION_URL,
          }),
          [`Cloud session: session_01abc (${SESSION_URL})`],
        ),
      ]);
      const { tasks, input } = runInput();

      const result = yield* makeClaudeCloudBackend({ cli }).run(input);

      assert.deepStrictEqual(calls[0]?.args, ["-p", "--output-format", "json", "--cloud"]);
      assert.strictEqual(calls[0]?.stdin, "--fix the flaky test");
      assert.deepStrictEqual(tasks, [{ id: "session_01abc", url: SESSION_URL }]);
      assert.strictEqual(result.text, "Fixed the flaky test.");
      assert.strictEqual(result.session, "session_01abc");
    }),
  );

  it.effect("sends follow-ups to the thread's session", () =>
    Effect.gen(function* () {
      const { cli, calls } = scriptedCli([
        ok(JSON.stringify({ ok: true, session_id: "session_01abc", url: SESSION_URL })),
      ]);
      const { tasks, input } = runInput("session_01abc");

      const result = yield* makeClaudeCloudBackend({ cli }).run(input);

      assert.deepStrictEqual(calls[0]?.args, [
        "-p",
        "--output-format",
        "json",
        "--cloud",
        "session_01abc",
      ]);
      assert.deepStrictEqual(tasks, [{ id: "session_01abc", url: SESSION_URL }]);
      assert.include(result.text, SESSION_URL);
      assert.strictEqual(result.session, "session_01abc");
    }),
  );

  it.effect("fails with Claude Code's own error", () =>
    Effect.gen(function* () {
      const rejected = scriptedCli([
        { stdout: "", stderr: "Error: Cloud sessions need a claude.ai sign-in.", code: 1 },
      ]);
      const archived = scriptedCli([
        {
          stdout: JSON.stringify({ ok: false, session_id: "s", error: "session is archived" }),
          stderr: "",
          code: 1,
        },
      ]);

      const rejectedExit = yield* makeClaudeCloudBackend({ cli: rejected.cli })
        .run(runInput().input)
        .pipe(Effect.exit);
      const archivedExit = yield* makeClaudeCloudBackend({ cli: archived.cli })
        .run(runInput("s").input)
        .pipe(Effect.exit);

      assert.include(
        String(Exit.isFailure(rejectedExit) && rejectedExit.cause),
        "claude.ai sign-in",
      );
      assert.include(
        String(Exit.isFailure(archivedExit) && archivedExit.cause),
        "session is archived",
      );
    }),
  );
});
