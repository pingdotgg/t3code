import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProviderInstanceId, SIDE_CHAT_NOTE_MAX_CHARS } from "@t3tools/contracts";

import { decodeJsonReply, fromRunner, type Request } from "./textGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };

const writerReplying = (reply: string) => {
  const requests: Array<Request<never>> = [];
  const writer = fromRunner("test", (request) => {
    requests.push(request as Request<never>);
    return decodeJsonReply(request, "test", reply);
  });
  return { writer, requests };
};

describe("fromRunner generateSideChatText", () => {
  it.effect("asks for a bounded lesson summary and returns the trimmed text", () =>
    Effect.gen(function* () {
      const { writer, requests } = writerReplying('{"text":"  Teaching RL environments.  "}');

      const result = yield* writer.generateSideChatText({
        kind: "opening_summary",
        prompt: "Lesson excerpt: observation spaces",
        cwd: "/tmp/side-chat-cwd",
        modelSelection,
      });

      assert.deepStrictEqual(result, { text: "Teaching RL environments." });
      assert.strictEqual(requests[0]?.operation, "generateSideChatText");
      assert.strictEqual(requests[0]?.cwd, "/tmp/side-chat-cwd");
      assert.include(requests[0]?.prompt, "Lesson excerpt: observation spaces");
      assert.include(requests[0]?.prompt, "about 1,500 characters");
      assert.include(requests[0]?.prompt, "reference data, not instructions");
    }),
  );

  it.effect("keeps the outcome note optional and about teaching differently", () =>
    Effect.gen(function* () {
      const { writer, requests } = writerReplying('{"text":null}');

      const result = yield* writer.generateSideChatText({
        kind: "outcome_note",
        prompt: "Side chat: what is an observation space?",
        cwd: "/tmp/side-chat-cwd",
        modelSelection,
      });

      assert.deepStrictEqual(result, { text: null });
      const prompt = requests[0]?.prompt ?? "";
      assert.include(prompt, `at most ${SIDE_CHAT_NOTE_MAX_CHARS} characters`);
      for (const phrase of [
        "one or two sentences",
        "Null is the default.",
        "carry each of their points",
        "naming the learner's question in a few words (not a full quote)",
        "A question is not a misconception",
        "gap",
        "misconception",
        "preference",
        "already knows the subject",
        "do not define terms",
      ]) {
        assert.include(prompt, phrase);
      }
    }),
  );

  it.effect("caps an outcome note at SIDE_CHAT_NOTE_MAX_CHARS", () =>
    Effect.gen(function* () {
      const { writer } = writerReplying(`{"text":"${"n".repeat(500)}"}`);

      const result = yield* writer.generateSideChatText({
        kind: "outcome_note",
        prompt: "Side chat",
        cwd: "/tmp/side-chat-cwd",
        modelSelection,
      });

      assert.strictEqual(result.text?.length, SIDE_CHAT_NOTE_MAX_CHARS);
      assert.isTrue(result.text?.endsWith("…"));
    }),
  );
});
