import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makePiTextGeneration } from "./PiTextGeneration.ts";

const encoder = new TextEncoder();
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("PiTextGeneration", () => {
  it.effect("uses an isolated RPC session and parses structured output", () => {
    const commandTypes: string[] = [];
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const offer = (record: Record<string, unknown>) =>
          Queue.offer(stdout, encoder.encode(`${JSON.stringify(record)}\n`));
        const stdin = Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            const command = decodeRecord(new TextDecoder().decode(bytes).trim());
            const type = String(command["type"]);
            commandTypes.push(type);
            yield* offer({
              type: "response",
              id: command["id"],
              command: type,
              success: true,
              ...(type === "get_last_assistant_text"
                ? { data: { text: '{"title":"A useful title"}' } }
                : {}),
            });
            if (type === "prompt") yield* offer({ type: "agent_settled" });
          }),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(9876),
          exitCode: Deferred.await(exited),
          isRunning: Effect.succeed(true),
          kill: () =>
            Queue.end(stdout).pipe(
              Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
            ),
          unref: Effect.succeed(Effect.void),
          stdin,
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );

    return Effect.gen(function* () {
      const textGeneration = yield* makePiTextGeneration(
        { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        process.env,
      );
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Please investigate the flaky test",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "openai-codex/gpt-5.4",
          options: [{ id: "thinking", value: "max" }],
        },
      });
      expect(result).toEqual({ title: "A useful title" });
      expect(commandTypes).toEqual([
        "set_model",
        "set_thinking_level",
        "prompt",
        "get_last_assistant_text",
      ]);
    }).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
  });
});
