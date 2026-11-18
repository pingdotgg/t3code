import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  latestReply,
  markSpokenReply,
  nextButtonVoiceMode,
  nextShortcutVoiceMode,
} from "./voiceReplies.logic";

type Run = OrchestrationV2ThreadProjection["runs"][number];
type Item = OrchestrationV2ThreadProjection["turnItems"][number];

const run = (id: string, ordinal: number, status: Run["status"] = "completed") =>
  ({
    id,
    ordinal,
    status,
    completedAt: status === "completed" ? DateTime.makeUnsafe(ordinal * 1_000) : null,
  }) as unknown as Run;

const answer = (
  runId: string,
  ordinal: number,
  text: string,
  options: { streaming?: boolean; parentItemId?: string } = {},
) =>
  ({
    type: "assistant_message",
    runId,
    ordinal,
    text,
    streaming: options.streaming ?? false,
    parentItemId: options.parentItemId ?? null,
  }) as unknown as Item;

const projection = (runs: ReadonlyArray<Run>, turnItems: ReadonlyArray<Item>) =>
  ({ runs, turnItems }) as unknown as OrchestrationV2ThreadProjection;

it("reads the last top-level answer of the latest completed run", () => {
  const reply = latestReply(
    projection(
      [run("run-1", 1), run("run-2", 2), run("run-3", 3, "running")],
      [
        answer("run-1", 1, "Old reply."),
        answer("run-2", 2, "Looking now."),
        answer("run-2", 3, "Subagent text.", { parentItemId: "task" }),
        answer("run-2", 4, "The build passed."),
        answer("run-3", 5, "Still working."),
      ],
    ),
  );
  expect(reply).toEqual({ runId: "run-2", text: "The build passed.", completedAtMs: 2_000 });
});

it("waits while the answer is still streaming", () => {
  expect(
    latestReply(projection([run("run-1", 1)], [answer("run-1", 1, "The bu", { streaming: true })])),
  ).toBeNull();
});

it("has nothing to read without a completed run or an answer", () => {
  expect(latestReply(projection([run("run-1", 1, "interrupted")], []))).toBeNull();
  expect(latestReply(projection([run("run-1", 1)], [answer("run-1", 1, "   ")]))).toBeNull();
  const undated = { ...run("run-1", 1), completedAt: null } as unknown as Run;
  expect(latestReply(projection([undated], [answer("run-1", 1, "Done.")]))).toBeNull();
});

it("marks typed messages for spoken replies only while voice is on", () => {
  expect(markSpokenReply("Check the build", true)).toBe("🔊  Check the build");
  expect(markSpokenReply("Check the build", false)).toBe("Check the build");
  expect(markSpokenReply("/compact", true)).toBe("/compact");
  expect(markSpokenReply("🎙  spoken words", true)).toBe("🎙  spoken words");
});

it("steps the voice button from off to one-way, two-way, and off again", () => {
  expect(nextButtonVoiceMode("off")).toBe("oneWay");
  expect(nextButtonVoiceMode("oneWay")).toBe("twoWay");
  expect(nextButtonVoiceMode("twoWay")).toBe("off");
});

it("turns voice on one-way by shortcut, then switches between one-way and two-way", () => {
  expect(nextShortcutVoiceMode("off")).toBe("oneWay");
  expect(nextShortcutVoiceMode("oneWay")).toBe("twoWay");
  expect(nextShortcutVoiceMode("twoWay")).toBe("oneWay");
});
