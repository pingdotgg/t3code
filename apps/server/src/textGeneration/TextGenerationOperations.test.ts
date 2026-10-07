import { assert, describe, it } from "@effect/vitest";
import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { fromRunner, resolveWorkingDirectory, type Runner } from "./TextGenerationOperations.ts";

const modelSelection = ModelSelection.make({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
});

describe("fromRunner explainProviderFailure", () => {
  it.effect("sends the failure context and trims and bounds the reply", () =>
    Effect.gen(function* () {
      const requests: Array<{ operation: string; cwd: string | null; prompt: string }> = [];
      const run = ((request: { operation: string; cwd: string | null; prompt: string }) => {
        requests.push(request);
        return Effect.succeed({
          summary: `  ${"s".repeat(700)}  `,
          likelyFix: `\n${"f".repeat(1_000)}\n`,
        });
      }) as unknown as Runner;

      const result = yield* fromRunner("test", run).explainProviderFailure({
        context: "Message: spawn codex ENOENT",
        modelSelection,
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.operation, "explainProviderFailure");
      // No project access: the provider substitutes an empty temporary directory.
      assert.isNull(requests[0]?.cwd);
      assert.include(requests[0]?.prompt, "Message: spawn codex ENOENT");
      assert.equal(result.summary.length, 600);
      assert.isTrue(result.summary.endsWith("..."));
      assert.equal(result.likelyFix.length, 900);
      assert.isTrue(result.likelyFix.endsWith("..."));
    }),
  );

  it.effect("keeps short replies as the model wrote them, minus surrounding whitespace", () =>
    Effect.gen(function* () {
      const run = (() =>
        Effect.succeed({
          summary: "  The binary is missing. ",
          likelyFix: " Install it. ",
        })) as unknown as Runner;

      const result = yield* fromRunner("test", run).explainProviderFailure({
        context: "x",
        modelSelection,
      });

      assert.deepEqual(result, {
        summary: "The binary is missing.",
        likelyFix: "Install it.",
        matchingIssueNumber: null,
      });
    }),
  );

  const knownIssues = [
    { number: 12, title: "Codex binary not found", state: "open" },
    { number: 40, title: "Session hangs", state: "closed" },
  ];
  const runReturning = (matchingIssueNumber: number | null) =>
    (() =>
      Effect.succeed({
        summary: "The binary is missing.",
        likelyFix: "Install it.",
        matchingIssueNumber,
      })) as unknown as Runner;

  it.effect("lists known issues to the model and returns the one it names", () =>
    Effect.gen(function* () {
      const prompts: Array<string> = [];
      const run = ((request: { prompt: string }) => {
        prompts.push(request.prompt);
        return Effect.succeed({
          summary: "The binary is missing.",
          likelyFix: "Install it.",
          matchingIssueNumber: 40,
        });
      }) as unknown as Runner;

      const result = yield* fromRunner("test", run).explainProviderFailure({
        context: "x",
        knownIssues,
        modelSelection,
      });

      assert.equal(result.matchingIssueNumber, 40);
      assert.include(prompts[0], "#12 [open] Codex binary not found");
      assert.include(prompts[0], "#40 [closed] Session hangs");
    }),
  );

  it.effect("ignores a matching number the model was not shown", () =>
    Effect.gen(function* () {
      const result = yield* fromRunner("test", runReturning(99)).explainProviderFailure({
        context: "x",
        knownIssues,
        modelSelection,
      });
      assert.isNull(result.matchingIssueNumber);
    }),
  );

  it.effect("ignores a matching number when no issues were offered", () =>
    Effect.gen(function* () {
      const result = yield* fromRunner("test", runReturning(12)).explainProviderFailure({
        context: "x",
        modelSelection,
      });
      assert.isNull(result.matchingIssueNumber);
    }),
  );
});

describe("resolveWorkingDirectory", () => {
  it.effect("uses the project directory when the request has one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* resolveWorkingDirectory(fileSystem, {
        operation: "generateBranchName",
        cwd: "/repo",
      }).pipe(Effect.scoped);
      assert.equal(directory, "/repo");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives a project-less request an empty directory that goes with its scope", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let inside: ReadonlyArray<string> | undefined;
      const directory = yield* Effect.gen(function* () {
        const created = yield* resolveWorkingDirectory(fileSystem, {
          operation: "explainProviderFailure",
          cwd: null,
        });
        inside = yield* fileSystem.readDirectory(created);
        return created;
      }).pipe(Effect.scoped);
      assert.deepEqual(inside, []);
      assert.isFalse(yield* fileSystem.exists(directory));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
