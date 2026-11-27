import { describe, expect, it } from "@effect/vitest";

import { withVisualReplyInstructions } from "./visualReply.ts";

const context = { version: 1 as const, records: [], visualReply: true };

describe("withVisualReplyInstructions", () => {
  it("asks for a visual after the user's own words", () => {
    const text = withVisualReplyInstructions(
      { role: "user", text: "Explain this paper to me", context },
      "Explain this paper to me",
    );
    expect(text.startsWith("Explain this paper to me\n\n")).toBe(true);
    expect(text).toContain("openui_guide");
    expect(text).toContain("html_render");
  });

  it("leaves a message alone when the sender did not ask", () => {
    expect(withVisualReplyInstructions({ role: "user", text: "Hi" }, "Hi")).toBe("Hi");
  });

  it.each(["/compact", "/goal ship it", "/review src"])("leaves the command %s alone", (text) => {
    expect(withVisualReplyInstructions({ role: "user", text, context }, text)).toBe(text);
  });
});
