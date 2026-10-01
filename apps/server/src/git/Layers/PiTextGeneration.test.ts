import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodeRecordLine = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

/**
 * Fake `pi --mode rpc` for one ephemeral generation: records the request
 * types it receives, settles right after the prompt, and replies with
 * `assistantText`.
 */
function fakePiSpawner(assistantText: string, requests: Array<Record<string, unknown>>) {
  return ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const emit = (record: Record<string, unknown>) =>
        Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
      let buffer = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffer += new TextDecoder().decode(chunk);
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
              const record = decodeRecordLine(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              requests.push(record);
              const data =
                record["type"] === "get_last_assistant_text" ? { text: assistantText } : undefined;
              yield* emit({ type: "response", id: record["id"], success: true, data });
              if (record["type"] === "prompt") yield* emit({ type: "agent_settled" });
              newline = buffer.indexOf("\n");
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

it.effect("applies the selected thinking level for titles", () =>
  Effect.gen(function* () {
    const requests: Array<Record<string, unknown>> = [];
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        fakePiSpawner('{"title":"Fix this"}', requests),
      ),
    );

    const generated = yield* textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "fix this",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/claude-sonnet-5",
        options: [{ id: "thinking", value: "high" }],
      },
    });

    assert.deepStrictEqual(generated, { title: "Fix this" });
    assert.deepStrictEqual(
      requests.map((record) => record["type"]),
      ["set_model", "set_thinking_level", "prompt", "get_last_assistant_text"],
    );
    assert.strictEqual(requests[1]?.["level"], "high");
  }),
);

it.effect("defers to Pi default model without set_model", () =>
  Effect.gen(function* () {
    const requests: Array<Record<string, unknown>> = [];
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        fakePiSpawner('{"subject":"Fix bug","body":"Details"}', requests),
      ),
    );

    const generated = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "one file",
      stagedPatch: "diff",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "default",
      },
    });

    assert.strictEqual(generated.subject, "Fix bug");
    assert.isFalse(requests.some((record) => record["type"] === "set_model"));
  }),
);
