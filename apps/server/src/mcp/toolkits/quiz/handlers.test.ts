import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { shownTutorText } from "./handlers.ts";

const at = (second: number, role: string, text: string, id = `${role}-${second}`) => ({
  id,
  role,
  text: "x".repeat(text.length),
  createdAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 16, 52, second)),
});

describe("quiz card reply visibility", () => {
  // Projection order from a real lesson: the queued send sits after the tutor's text,
  // and earlier card replies are appended last.
  it("counts real tutor text since the learner's last message, in time order", () => {
    const messages = [
      at(26, "user", "answer to card 1"),
      at(36, "assistant", "v".repeat(321)),
      at(31, "user", "queued send"),
      at(6, "assistant", "r".repeat(265), "toolu_1:reply"),
    ];
    expect(shownTutorText(messages)).toBe(321);
  });

  it("does not count promoted thinking summaries", () => {
    const thinking = at(
      36,
      "assistant",
      "t".repeat(300),
      "message:provider:claudeAgent:native-item:msg_011CgpYTQZCUAf5iyjZ9S6jP%3Athinking%3A1",
    );
    expect(shownTutorText([at(26, "user", "answer"), thinking])).toBe(0);
  });
});
