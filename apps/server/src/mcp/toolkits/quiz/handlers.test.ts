import { describe, expect, it } from "vite-plus/test";

import { cardReplyProblem } from "@t3tools/shared/quizCard";
import { shownTutorText } from "./handlers.ts";

describe("quiz card reply visibility", () => {
  it("does not count promoted thinking summaries, but counts real text", () => {
    const thinking = {
      id: "message:provider:claude:native:thinking:0",
      role: "assistant",
      text: "x".repeat(300),
    };
    const real = {
      id: "message:provider:claude:native:reply",
      role: "assistant",
      text: "x".repeat(300),
    };
    expect(shownTutorText([{ id: "user", role: "user", text: "Answer" }, thinking])).toBe(0);
    expect(cardReplyProblem({ reply: "Short.", shownBefore: 0 })).toBeDefined();
    expect(shownTutorText([{ id: "user", role: "user", text: "Answer" }, real])).toBe(300);
    expect(cardReplyProblem({ reply: "Short.", shownBefore: 300 })).toBeUndefined();
  });
});
