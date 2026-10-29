import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { FxSettings } from "../settings.ts";
import { makeFxTextGeneration } from "./textGeneration.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(FxSettings)({ enabled: true });
const instanceId = ProviderInstanceId.make("fx");

interface FxRun {
  readonly code: number;
  readonly finalOutput: string;
  readonly error?: string;
  readonly stderr?: string;
}

/** `fx ask --json` from fx 0.0.15, trimmed to the fields T3 reads plus a few it ignores. */
const askJson = (run: FxRun) =>
  JSON.stringify({
    output: run.finalOutput,
    final_output: run.finalOutput,
    exit_code: run.code,
    model: run.code === 0 ? "anthropic/claude-opus-5.5" : "",
    session_id: "",
    steps: 0,
    tool_calls: [],
    ...(run.error === undefined ? {} : { error: run.error }),
  }) + "\n";

function processHandle(run: FxRun) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_102),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(run.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.succeed(encoder.encode(askJson(run))),
    stderr: run.stderr ? Stream.succeed(encoder.encode(run.stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Generates a commit message against a fake `fx` and returns what it was launched with. */
const generateCommit = (
  run: FxRun,
  options?: ReadonlyArray<ProviderOptionSelection>,
  model = "default",
) =>
  Effect.gen(function* () {
    const launches: Array<{
      args: ReadonlyArray<string>;
      cwd: string | undefined;
      env: Record<string, string | undefined> | undefined;
      stdin: string;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("piped command");
        const stdin = command.options.stdin;
        launches.push({
          args: command.args,
          cwd: command.options.cwd,
          env: command.options.env,
          stdin:
            typeof stdin === "object" && "stream" in stdin && typeof stdin.stream === "object"
              ? yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie)
              : "",
        });
        return processHandle(run);
      }),
    );
    const textGeneration = yield* makeFxTextGeneration(settings, {
      PATH: "/usr/bin",
      FX_PERMISSION_MODE: "yolo",
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const result = yield* textGeneration
      .generateCommitMessage({
        cwd: "/repo",
        branch: "main",
        stagedSummary: "M src/greeting.ts",
        stagedPatch: "diff --git a/src/greeting.ts b/src/greeting.ts",
        modelSelection: createModelSelection(instanceId, model, options),
      })
      .pipe(Effect.result);
    return { result, launches };
  });

describe("makeFxTextGeneration", () => {
  it.effect("asks fx once, unsaved and without approvals, outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { result, launches } = yield* generateCommit({
        code: 0,
        // Models often wrap the requested JSON in prose.
        finalOutput:
          'Here is the message:\n{"subject":"feat: greet by name","body":"- adds a name"}',
      });

      assert.deepEqual(
        result,
        Result.succeed({ subject: "feat: greet by name", body: "- adds a name" }),
      );
      const [launch] = launches;
      assert.equal(launches.length, 1);
      assert.deepEqual(launch?.args, ["ask", "--no-save", "--json", "--effort", "medium"]);
      assert.equal(launch?.env?.FX_PERMISSION_MODE, "ask");
      assert.include(launch?.stdin, "M src/greeting.ts");
      assert.notEqual(launch?.cwd, "/repo");
      assert.isFalse(yield* fs.exists(launch?.cwd ?? "/repo"), "temp directory is removed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes the selected model and effort", () =>
    Effect.gen(function* () {
      const { launches } = yield* generateCommit(
        { code: 0, finalOutput: '{"subject":"fix: x","body":""}' },
        [{ id: "effort", value: "xhigh" }],
        "anthropic/claude-opus-5.5",
      );
      assert.deepEqual(launches[0]?.args, [
        "ask",
        "--no-save",
        "--json",
        "--model",
        "anthropic/claude-opus-5.5",
        "--effort",
        "xhigh",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "a tool call that needs approval",
      run: {
        code: 1,
        finalOutput: "",
        error: "NonInteractivePermissionRequired",
        stderr:
          "fx ask: permission required for tool execution in noninteractive mode\nfx ask: blocked action: Writing file\n",
      },
      detail: "fx asked for approval to use a tool. Text generation runs fx without approvals.",
    },
    {
      name: "a signed-out fx",
      run: {
        code: 1,
        finalOutput: "",
        error: "MissingCredentials",
        stderr:
          "fx ask: fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.\n",
      },
      detail:
        "fx ask failed: fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.",
    },
    {
      name: "an empty reply",
      run: { code: 0, finalOutput: "", stderr: "Reading src/greeting.ts\n" },
      detail: "fx returned empty output.",
    },
    {
      name: "a reply without the JSON",
      run: { code: 0, finalOutput: "feat: greet by name" },
      detail: "fx returned invalid structured output.",
    },
  ])("reports $name", ({ run, detail }) =>
    Effect.gen(function* () {
      const { result } = yield* generateCommit(run);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.detail, detail);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
