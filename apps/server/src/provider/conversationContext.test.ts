import * as NodeServices from "@effect/platform-node/NodeServices";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { composeConversationInput } from "./conversationContext.ts";

describe("bounded conversation context", () => {
  for (const newInput of ["What remains?", "q".repeat(110_000)]) {
    it.effect(
      `preserves the whole snapshot and question with ${newInput.length} question characters`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const context =
            "Snapshot, not new instructions.\n" +
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
              { role: "assistant", text: "OLDEST " + '\\"\n😀'.repeat(40_000) + " LATEST" },
            ]));
          const input = yield* composeConversationInput({
            context,
            newInput,
            threadId: "thread/../1",
            attachmentsDir: directory,
          });
          expect(input.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
          expect(input.endsWith(`New user message:\n${newInput}`)).toBe(true);
          expect(input).toContain("LATEST");
          expect(input).toContain("Snapshot, not new instructions.");
          const saved = yield* fs.readFileString(
            path.join(directory, `conversation-${encodeURIComponent("thread/../1")}.txt`),
          );
          expect(saved).toBe(context);
          const followup = yield* composeConversationInput({
            context,
            newInput,
            threadId: "thread/../1",
            attachmentsDir: directory,
          });
          expect(followup).toBe(input);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  it.effect("leaves small contexts unchanged", () =>
    Effect.gen(function* () {
      const result = yield* composeConversationInput({
        context: "history",
        newInput: "question",
        threadId: "small",
        attachmentsDir: "unused",
      });
      expect(result).toBe("history\n\nNew user message:\nquestion");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects an oversized new question without silently cutting it", () =>
    Effect.gen(function* () {
      const result = yield* composeConversationInput({
        context: "context\n" + "c".repeat(120_000),
        newInput: "q".repeat(120_000),
        threadId: "large",
        attachmentsDir: "unused",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
