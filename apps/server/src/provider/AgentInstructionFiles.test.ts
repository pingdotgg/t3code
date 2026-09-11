import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { syncAgentInstructionFile, agentInstructionRelativePath } from "./AgentInstructionFiles.ts";

it.effect(
  "isolates concurrent chats, cleans only the settled chat, and restores its frozen prompt",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const first = { cwd, threadId: "chat-one", instructions: "Plan carefully.", settled: false };
      const second = { ...first, threadId: "chat-two", instructions: "Write code." };
      yield* Effect.all([syncAgentInstructionFile(first), syncAgentInstructionFile(second)], {
        concurrency: 2,
      });
      const firstPath = path.join(cwd, agentInstructionRelativePath(first.threadId));
      const secondPath = path.join(cwd, agentInstructionRelativePath(second.threadId));
      yield* fs.writeFileString(path.join(cwd, ".agents", "notes.md"), "Keep this user file.");
      yield* syncAgentInstructionFile({ ...first, settled: true });
      assert.isFalse(yield* fs.exists(firstPath));
      assert.isTrue(yield* fs.exists(secondPath));
      assert.equal(
        yield* fs.readFileString(path.join(cwd, ".agents", "notes.md")),
        "Keep this user file.",
      );
      yield* syncAgentInstructionFile(first);
      assert.include(yield* fs.readFileString(firstPath), "Plan carefully.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
