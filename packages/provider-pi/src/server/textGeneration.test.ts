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

import { makePiTextGeneration } from "./textGeneration.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeFakePi = (
  reply: string,
  setModelError?: string,
  turnEvents: ReadonlyArray<Record<string, unknown>> = [],
  models: ReadonlyArray<Record<string, unknown>> = [],
  catalogError?: string,
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
            yield* emit({ type: "agent_settled" });
          } else if (record["type"] === "get_last_assistant_text") {
            yield* emit({ ...response, success: true, data: { text: reply } });
          } else if (record["type"] === "get_available_models") {
            yield* emit(
              catalogError === undefined
                ? { ...response, success: true, data: { models } }
                : { ...response, success: false, error: catalogError },
            );
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
          // Outside the valid pid range, so PiRpc's process-group kill never lands.
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

it.effect("runs Pi offline, since the process is stopped as soon as it answers", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi(JSON.stringify({ subject: "Update README", body: "" }));
    const launches: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) launches.push(command.args.map(String));
      return pi.spawner.spawn(command);
    });
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const result = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "default"),
    });

    assert.equal(result.subject, "Update README");
    assert.deepEqual(
      launches.map((args) => args.filter((arg) => arg === "--offline")),
      [["--offline"]],
    );
  }),
);

it.effect("names the model and the disabled extensions when Pi cannot load it", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("", "Model not found: demo/demo-model");
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "demo/demo-model"),
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "Pi rejected model 'demo/demo-model'");
    assert.include(error.detail, "Model not found: demo/demo-model");
    assert.include(error.detail, "--no-extensions");
    assert.isUndefined(pi.received.find((record) => record["type"] === "prompt"));
  }),
);

const selectModel = (
  model: string,
  models: ReadonlyArray<Record<string, unknown>>,
  catalogError?: string,
) =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi(
      JSON.stringify({ subject: "Update README", body: "" }),
      undefined,
      [],
      models,
      catalogError,
    );
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(ProviderInstanceId.make("pi"), model),
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
    const setModel = pi.received.find((record) => record["type"] === "set_model");
    return {
      error,
      sent: setModel && { provider: setModel["provider"], modelId: setModel["modelId"] },
    };
  });

it.effect.each([
  {
    name: "slashes in both provider and model ID",
    model: "demo=http://127.0.0.1:9/org/demo-model",
    models: [
      { provider: "openrouter", id: "openrouter/auto" },
      { provider: "demo=http://127.0.0.1:9", id: "org/demo-model" },
    ],
    sent: { provider: "demo=http://127.0.0.1:9", modelId: "org/demo-model" },
  },
  {
    name: "a model ID with a slash",
    model: "openrouter/openrouter/auto",
    models: [{ provider: "openrouter", id: "openrouter/auto" }],
    sent: { provider: "openrouter", modelId: "openrouter/auto" },
  },
  {
    name: "a custom model Pi does not list, split at the first slash",
    model: "custom/org/model",
    models: [],
    sent: { provider: "custom", modelId: "org/model" },
  },
])("sends Pi the resolved provider and model ID for $name", ({ model, models, sent }) =>
  Effect.gen(function* () {
    const result = yield* selectModel(model, models);

    assert.isUndefined(result.error);
    assert.deepEqual(result.sent, sent);
  }),
);

it.effect("refuses a model slug that matches two listed Pi models", () =>
  Effect.gen(function* () {
    const { error, sent } = yield* selectModel("a/b/c", [
      { provider: "a", id: "b/c" },
      { provider: "a/b", id: "c" },
    ]);

    assert.include(error?.detail, "Pi lists more than one model as 'a/b/c'");
    assert.notInclude(error?.detail ?? "", "--no-extensions");
    assert.isUndefined(sent);
  }),
);

it.effect("preserves model discovery errors during text generation", () =>
  Effect.gen(function* () {
    const { error, sent } = yield* selectModel("demo/org/model", [], "Catalog unavailable");

    assert.include(error?.detail ?? "", "Catalog unavailable");
    assert.notInclude(error?.detail ?? "", "--no-extensions");
    assert.isUndefined(sent);
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
    const pi = yield* makeFakePi(reply, undefined, turnEvents);
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    return yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "default"),
    });
  });

it.effect("reports Pi's turn error when the reply is empty", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([failedTurn]).pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.equal(error.detail, "Pi could not generate text: the model provider returned HTTP 401.");
  }),
);

it.effect("keeps Pi's raw error text out of the error", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([
      failedTurnWith("Invalid API key sk-test-SECRET123"),
    ]).pipe(Effect.flip);

    assert.equal(error.detail, "Pi could not generate text: the model provider reported an error.");
    assert.notInclude(error.message, "SECRET123");
  }),
);

it.effect("keeps the reply when Pi answers after a failed attempt", () =>
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

    assert.equal(error.detail, "Pi returned empty output.");
  }),
);
