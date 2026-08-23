import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AgySettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeAgyTextGeneration } from "./AgyTextGeneration.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeFakeAgy = Effect.fn("makeFakeAgy")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agy-text-" });
  const scriptPath = path.join(directory, "agy-stub.mjs");
  const binaryPath = path.join(directory, "agy");
  const argsPath = path.join(directory, "args.log");

  yield* fileSystem.writeFileString(
    scriptPath,
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.T3_FAKE_AGY_ARGS_PATH, process.argv.slice(2).join(" "));',
      'process.stdout.write(process.env.T3_FAKE_AGY_OUTPUT ?? "");',
      'process.stderr.write(process.env.T3_FAKE_AGY_STDERR ?? "");',
      'process.exitCode = Number(process.env.T3_FAKE_AGY_EXIT_CODE ?? "0");',
      "",
    ].join("\n"),
  );
  yield* fileSystem.writeFileString(
    binaryPath,
    ["#!/bin/sh", `exec node ${encodeJsonString(scriptPath)} "$@"`, ""].join("\n"),
  );
  yield* fileSystem.chmod(binaryPath, 0o755);

  return { argsPath, binaryPath };
});

it.layer(NodeServices.layer)("AgyTextGeneration", (it) => {
  it.effect("generates structured output with the selected model and effort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const fake = yield* makeFakeAgy();
        const textGeneration = yield* makeAgyTextGeneration(
          decodeAgySettings({ binaryPath: fake.binaryPath }),
          {
            ...process.env,
            T3_FAKE_AGY_ARGS_PATH: fake.argsPath,
            T3_FAKE_AGY_OUTPUT: encodeJsonString({
              status: "SUCCESS",
              structured_output: {
                subject: "Add Antigravity provider",
                body: "Wire the agy harness into T3 Code.",
              },
            }),
          },
        );

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feat/antigravity-provider",
          stagedSummary: "Add the agy provider",
          stagedPatch: "diff --git a/agy b/agy",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("agy"),
            "gemini-3.7-flash-high",
            [{ id: "reasoningEffort", value: "medium" }],
          ),
        });

        expect(generated).toEqual({
          subject: "Add Antigravity provider",
          body: "Wire the agy harness into T3 Code.",
        });
        const args = yield* fileSystem.readFileString(fake.argsPath);
        expect(args).toContain("--output-format json");
        expect(args).toContain("--json-schema");
        expect(args).toContain("--model gemini-3.7-flash-medium");
        expect(args).toContain("--effort medium");
        expect(args).toContain("--dangerously-skip-permissions");
      }),
    ),
  );

  it.effect("reports non-zero CLI exits as text-generation errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeAgy();
        const textGeneration = yield* makeAgyTextGeneration(
          decodeAgySettings({ binaryPath: fake.binaryPath }),
          {
            ...process.env,
            T3_FAKE_AGY_ARGS_PATH: fake.argsPath,
            T3_FAKE_AGY_STDERR: "authentication required",
            T3_FAKE_AGY_EXIT_CODE: "1",
          },
        );

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("agy"),
              model: "gemini-3.7-flash-high",
            },
          })
          .pipe(Effect.flip);

        expect(error.detail).toContain("authentication required");
      }),
    ),
  );
});
