import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeOmpTextGeneration } from "./textGeneration.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeFakeOmp = (
  reply: string,
  setModelError?: string,
  turnEvents: ReadonlyArray<Record<string, unknown>> = [],
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const received: Array<Record<string, unknown>> = [];
    const emit = (record: Record<string, unknown>) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
    let buffered = "";
    const onStdin = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        buffered += new TextDecoder().decode(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter((candidate) => candidate.length > 0)) {
          const record = decodeJsonLine(line) as Record<string, unknown>;
          received.push(record);
          const response = { type: "response", id: record["id"], command: record["type"] };
          if (record["type"] === "prompt") {
            yield* emit({ ...response, success: true });
            for (const event of turnEvents) yield* emit(event);
            yield* emit({ type: "session_settled" });
          } else if (record["type"] === "get_last_assistant_text") {
            yield* emit({ ...response, success: true, data: { text: reply } });
          } else if (record["type"] === "set_model" && setModelError !== undefined) {
            yield* emit({ ...response, success: false, error: setModelError });
          } else {
            yield* emit({ ...response, success: true });
          }
        }
      });
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          // Outside the valid pid range, so OmpRpc's process-group kill never lands.
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return { spawner, received };
  });

it.effect("runs OMP helpers without tools or persistent sessions", () =>
  Effect.gen(function* () {
    const omp = yield* makeFakeOmp(JSON.stringify({ subject: "Update README", body: "" }));
    const launches: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) launches.push(command.args.map(String));
      return omp.spawner.spawn(command);
    });
    const textGeneration = yield* makeOmpTextGeneration(
      { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const result = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
    });

    assert.equal(result.subject, "Update README");
    assert.deepEqual(
      launches.map((args) => args.filter((arg) => arg === "--no-session" || arg === "--no-tools")),
      [["--no-session", "--no-tools"]],
    );
  }),
);

it.effect("names the model and the disabled extensions when Omp cannot load it", () =>
  Effect.gen(function* () {
    const omp = yield* makeFakeOmp("", "Model not found: demo/demo-model");
    const textGeneration = yield* makeOmpTextGeneration(
      { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner));

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "demo/demo-model"),
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "Omp rejected model 'demo/demo-model'");
    assert.include(error.detail, "Model not found: demo/demo-model");
    assert.include(error.detail, "--no-extensions");
    assert.isUndefined(omp.received.find((record) => record["type"] === "prompt"));
  }),
);

const failedTurnWith = (errorMessage: string) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage },
});

const failedTurn = failedTurnWith(
  '401: {"error":{"message":"Incorrect API key provided: sk-test-SECRET123"}}',
);

const generateCommitMessage = (turnEvents: ReadonlyArray<Record<string, unknown>>, reply = "") =>
  Effect.gen(function* () {
    const omp = yield* makeFakeOmp(reply, undefined, turnEvents);
    const textGeneration = yield* makeOmpTextGeneration(
      { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner));
    return yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
    });
  });

it.effect("reports Omp's turn error when the reply is empty", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([failedTurn]).pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.equal(
      error.detail,
      "Omp could not generate text: the model provider returned HTTP 401.",
    );
  }),
);

it.effect("keeps Omp's raw error text out of the error", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([
      failedTurnWith("Invalid API key sk-test-SECRET123"),
    ]).pipe(Effect.flip);

    assert.equal(
      error.detail,
      "Omp could not generate text: the model provider reported an error.",
    );
    assert.notInclude(error.message, "SECRET123");
  }),
);

it.effect("keeps the reply when Omp answers after a failed attempt", () =>
  Effect.gen(function* () {
    const result = yield* generateCommitMessage(
      [failedTurn, { type: "message_end", message: { role: "assistant", stopReason: "stop" } }],
      JSON.stringify({ subject: "Update README", body: "" }),
    );

    assert.equal(result.subject, "Update README");
  }),
);

it.effect("drops an earlier error once a later attempt succeeds", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([
      failedTurn,
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ]).pipe(Effect.flip);

    assert.equal(error.detail, "Omp returned empty output.");
  }),
);
