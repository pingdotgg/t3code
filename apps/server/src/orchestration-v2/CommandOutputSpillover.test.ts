import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  MAX_INLINE_COMMAND_OUTPUT_CHARS,
  MAX_INLINE_COMMAND_OUTPUT_LINES,
  shouldSpilloverCommandOutput,
  spilloverCommandOutputTurnItem,
} from "./CommandOutputSpillover.ts";

interface CreateTurnItemOptions {
  readonly id?: TurnItemId;
  readonly output?: string | undefined;
  readonly outputFilePath?: string | undefined;
}

function createTurnItem(
  now: DateTime.Utc,
  options?: CreateTurnItemOptions,
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    id: options?.id ?? TurnItemId.make("item-123"),
    threadId: ThreadId.make("thread-abc"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    status: "completed",
    input: "npm test",
    ...(options?.output !== undefined ? { output: options.output } : {}),
    ...(options?.outputFilePath !== undefined ? { outputFilePath: options.outputFilePath } : {}),
  };
}

describe("shouldSpilloverCommandOutput", () => {
  it("returns false for short outputs under both limits", () => {
    assert.isFalse(shouldSpilloverCommandOutput("Hello world\nLine 2\n"));
    assert.isFalse(shouldSpilloverCommandOutput("a".repeat(10_000)));
  });

  it("returns false for exactly at the character limit", () => {
    assert.isFalse(shouldSpilloverCommandOutput("a".repeat(MAX_INLINE_COMMAND_OUTPUT_CHARS)));
  });

  it("returns true when character limit is exceeded", () => {
    assert.isTrue(shouldSpilloverCommandOutput("a".repeat(MAX_INLINE_COMMAND_OUTPUT_CHARS + 1)));
  });

  it("returns true when line limit is exceeded even if under char limit", () => {
    const manyLines = "line\n".repeat(MAX_INLINE_COMMAND_OUTPUT_LINES + 5);
    assert.isBelow(manyLines.length, MAX_INLINE_COMMAND_OUTPUT_CHARS);
    assert.isTrue(shouldSpilloverCommandOutput(manyLines));
  });

  it("respects custom limits", () => {
    assert.isFalse(shouldSpilloverCommandOutput("abc", { maxChars: 5, maxLines: 5 }));
    assert.isTrue(shouldSpilloverCommandOutput("abcdef", { maxChars: 5, maxLines: 5 }));
    assert.isTrue(
      shouldSpilloverCommandOutput("a\nb\nc\nd\ne\nf\n", { maxChars: 100, maxLines: 3 }),
    );
  });
});

it.layer(NodeServices.layer)("spilloverCommandOutputTurnItem", (it) => {
  it.effect("leaves outputs within threshold inline without writing to disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const now = yield* DateTime.now;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spillover-test-" });

        const item = createTurnItem(now, { output: "Tests passed: 42 passed, 0 failed\n" });
        const result = yield* spilloverCommandOutputTurnItem(item, { commandLogsDir: tempDir });

        assert.strictEqual(result.type, "command_execution");
        if (result.type !== "command_execution") return;

        assert.strictEqual(result.output, "Tests passed: 42 passed, 0 failed\n");
        assert.isUndefined(result.outputFilePath);

        const files = yield* fs.readDirectory(tempDir);
        assert.deepStrictEqual(files, []);
      }),
    ),
  );

  it.effect("spills over output exceeding char threshold to disk and bounds preview", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const now = yield* DateTime.now;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spillover-test-" });

        const largeOutput =
          "A".repeat(MAX_INLINE_COMMAND_OUTPUT_CHARS + 5_000) + "\nFINAL_TEST_RESULT_OK\n";
        const item = createTurnItem(now, {
          id: TurnItemId.make("item:with/special:chars"),
          output: largeOutput,
        });

        const result = yield* spilloverCommandOutputTurnItem(item, { commandLogsDir: tempDir });

        assert.strictEqual(result.type, "command_execution");
        if (result.type !== "command_execution") return;

        assert.isDefined(result.outputFilePath);
        assert.isTrue(result.outputFilePath?.startsWith(tempDir));
        assert.isTrue(result.outputFilePath?.endsWith(".log"));

        // File on disk contains the full raw output
        const savedContent = yield* fs.readFileString(result.outputFilePath!);
        assert.strictEqual(savedContent, largeOutput);

        // Bounded preview in output
        assert.isDefined(result.output);
        assert.isTrue(
          result.output?.startsWith(
            `[Earlier output written to log file: ${result.outputFilePath}]`,
          ),
        );
        assert.isTrue(result.output?.includes("FINAL_TEST_RESULT_OK"));
        assert.isBelow(result.output!.length, largeOutput.length);
      }),
    ),
  );

  it.effect("spills over output exceeding line count threshold to disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const now = yield* DateTime.now;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spillover-test-" });

        const lines = Array.from({ length: 1_200 }, (_, i) => `Test log row ${i}`).join("\n");
        const item = createTurnItem(now, {
          id: TurnItemId.make("turn-line-overflow"),
          output: lines,
        });

        const result = yield* spilloverCommandOutputTurnItem(item, { commandLogsDir: tempDir });

        assert.strictEqual(result.type, "command_execution");
        if (result.type !== "command_execution") return;

        assert.isDefined(result.outputFilePath);
        const savedContent = yield* fs.readFileString(result.outputFilePath!);
        assert.strictEqual(savedContent, lines);

        assert.isTrue(
          result.output?.startsWith(
            `[Earlier output written to log file: ${result.outputFilePath}]`,
          ),
        );
        assert.isTrue(result.output?.includes("Test log row 1199"));
      }),
    ),
  );

  it.effect("ignores non-command_execution items and items without output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const now = yield* DateTime.now;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spillover-test-" });

        const nonCommandItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item-file-change"),
          threadId: ThreadId.make("thread-abc"),
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "file_change",
          fileName: "src/index.ts",
        };
        const res1 = yield* spilloverCommandOutputTurnItem(nonCommandItem, {
          commandLogsDir: tempDir,
        });
        assert.strictEqual(res1, nonCommandItem);

        const itemNoOutput = createTurnItem(now, { output: undefined });
        const res2 = yield* spilloverCommandOutputTurnItem(itemNoOutput, {
          commandLogsDir: tempDir,
        });
        assert.strictEqual(res2, itemNoOutput);

        const files = yield* fs.readDirectory(tempDir);
        assert.deepStrictEqual(files, []);
      }),
    ),
  );

  it.effect("does not re-spillover if outputFilePath is already set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const now = yield* DateTime.now;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spillover-test-" });

        const existingPath = path.join(tempDir, "existing.log");
        yield* fs.writeFileString(existingPath, "existing data");

        const item = createTurnItem(now, {
          output: "A".repeat(MAX_INLINE_COMMAND_OUTPUT_CHARS + 1_000),
          outputFilePath: existingPath,
        });

        const result = yield* spilloverCommandOutputTurnItem(item, { commandLogsDir: tempDir });
        assert.strictEqual(result, item);
        assert.strictEqual(result.type, "command_execution");
        if (result.type !== "command_execution") return;
        assert.strictEqual(result.outputFilePath, existingPath);
      }),
    ),
  );

  it.effect("uses ServerConfig.commandLogsDir from context when options are omitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const now = yield* DateTime.now;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spillover-config-test-" });

        const commandLogsDir = path.join(tempDir, "custom-commands");
        const largeOutput = "B".repeat(MAX_INLINE_COMMAND_OUTPUT_CHARS + 100);
        const item = createTurnItem(now, {
          id: TurnItemId.make("config-test-item"),
          output: largeOutput,
        });

        const result = yield* spilloverCommandOutputTurnItem(item).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            commandLogsDir,
            logsDir: tempDir,
          } as ServerConfig.ServerConfig["Service"]),
        );

        assert.strictEqual(result.type, "command_execution");
        if (result.type !== "command_execution") return;
        assert.isDefined(result.outputFilePath);
        assert.isTrue(result.outputFilePath?.startsWith(commandLogsDir));
        const exists = yield* fs.exists(result.outputFilePath!);
        assert.isTrue(exists);
      }),
    ),
  );
});
