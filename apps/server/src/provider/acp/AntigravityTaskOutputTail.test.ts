import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import { commandStep, makeProfile, ROOT } from "./AntigravityChildWork.testkit.ts";
import { tailAntigravityCommandOutput } from "./AntigravityTaskOutputTail.ts";

describe("tailAntigravityCommandOutput", () => {
  it.effect("discovers toolSummary and streams task-<idx>.log across split UTF-8 bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const callId = "call_capture_moons";
        const { profile } = yield* makeProfile({
          steps: () => [
            [
              42,
              132,
              commandStep({
                callId,
                commandLine: "python3 capture.py",
                toolSummary: "Check outer moons sky level and capture 60 frames if clean",
              }),
            ],
          ],
        });
        const tasksDir = path.join(
          profile,
          "antigravity-acp",
          "brain",
          ROOT,
          ".system_generated",
          "tasks",
        );
        const logFile = path.join(tasksDir, "task-42.log");
        yield* fileSystem.makeDirectory(tasksDir, { recursive: true });
        const encoded = new TextEncoder().encode("café frame 1\n");
        yield* fileSystem.writeFile(logFile, encoded.subarray(0, 4));
        const titles = yield* Queue.unbounded<string>();
        const chunks = yield* Queue.unbounded<string>();
        const stop = yield* Deferred.make<void>();

        const fiber = yield* tailAntigravityCommandOutput({
          profileDirectory: profile,
          sessionId: ROOT,
          toolCallId: callId,
          stop,
          onTitle: (title) => Queue.offer(titles, title),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);

        assert.equal(
          yield* Queue.take(titles),
          "Check outer moons sky level and capture 60 frames if clean",
        );
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(logFile, encoded);
        yield* Deferred.succeed(stop, undefined);
        assert.equal(yield* Queue.take(chunks), "é frame 1\n");
        yield* Fiber.await(fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a symlinked task log outside the profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const callId = "call_symlink";
        const { profile } = yield* makeProfile({
          steps: () => [
            [
              7,
              132,
              commandStep({
                callId,
                commandLine: "echo secret",
                toolSummary: "Symlink probe",
              }),
            ],
          ],
        });
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-outside-" });
        const secret = path.join(outside, "secret.log");
        yield* fileSystem.writeFileString(secret, "do not read\n");
        const tasksDir = path.join(
          profile,
          "antigravity-acp",
          "brain",
          ROOT,
          ".system_generated",
          "tasks",
        );
        yield* fileSystem.makeDirectory(tasksDir, { recursive: true });
        yield* fileSystem.symlink(secret, path.join(tasksDir, "task-7.log"));

        const chunks: string[] = [];
        const stop = yield* Deferred.make<void>();
        yield* Deferred.succeed(stop, undefined);
        yield* tailAntigravityCommandOutput({
          profileDirectory: profile,
          sessionId: ROOT,
          toolCallId: callId,
          stop,
          onChunk: (chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
            }),
        });
        assert.deepEqual(chunks, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
