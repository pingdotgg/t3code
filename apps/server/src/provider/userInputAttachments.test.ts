// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import {
  appendUserInputAttachmentPaths,
  normalizeUserInputAnswers,
} from "./userInputAttachments.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-answer-paths-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const attachment = {
  type: "file" as const,
  id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
  name: 'spec "final".txt',
  mimeType: "text/plain",
  sizeBytes: 4,
};
describe("question answer paths", () => {
  it.effect("keeps selected values intact and appends an actual readable server path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, `${attachment.id}.txt`);
      NodeFS.writeFileSync(path, "spec");
      const original = { q: ["First", "Second"], other: "No file" };
      const answers = yield* appendUserInputAttachmentPaths({
        answers: original,
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      });
      expect(answers.q).toEqual([
        "First",
        "Second",
        `Attached file "spec \\"final\\".txt": "${path}"`,
      ]);
      expect(answers.other).toBe("No file");
      expect(original.q).toEqual(["First", "Second"]);
      expect(NodeFS.readFileSync(path, "utf8")).toBe("spec");
      const specialKey = yield* appendUserInputAttachmentPaths({
        answers: {},
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { ["__proto__"]: [attachment] },
      });
      expect(Object.keys(specialKey)).toEqual(["__proto__"]);
      expect(specialKey["__proto__"]).toContain(path);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("does not send an unavailable attachment path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* appendUserInputAttachmentPaths({
        answers: { q: "" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
});

describe("normalizeUserInputAnswers", () => {
  it.effect("unwraps Codex-style answer objects and keeps strings and arrays", () =>
    Effect.gen(function* () {
      expect(yield* normalizeUserInputAnswers({ q: "Blue" })).toEqual({ q: "Blue" });
      expect(yield* normalizeUserInputAnswers({ q: ["First", "Second"] })).toEqual({
        q: ["First", "Second"],
      });
      expect(yield* normalizeUserInputAnswers({ q: { answers: ["Blue"] } })).toEqual({
        q: "Blue",
      });
      expect(yield* normalizeUserInputAnswers({ q: { answers: ["First", "Second"] } })).toEqual({
        q: ["First", "Second"],
      });
    }),
  );

  it.effect("fails unknown shapes before the request is consumed", () =>
    Effect.gen(function* () {
      for (const value of [
        42,
        null,
        {},
        ["kept", 5, null],
        { answers: ["ok", 7] },
        { answer: ["Blue"] },
      ]) {
        const error = yield* normalizeUserInputAnswers({ q: value }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderValidationError",
          operation: "respondToUserInput",
        });
        expect(error.issue).toContain("index 0");
      }
      const second = yield* normalizeUserInputAnswers({ ok: "fine", bad: 42 }).pipe(Effect.flip);
      expect(second.issue).toContain("index 1");
    }),
  );
});
