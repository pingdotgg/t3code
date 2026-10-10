import { describe, expect, it } from "@effect/vitest";

import { deriveThreadTitleSeed } from "./threadTitle.ts";

describe("deriveThreadTitleSeed", () => {
  it("prefers normalized message text", () => {
    expect(
      deriveThreadTitleSeed({
        text: "  Investigate\n  login   failures  ",
        attachments: [{ name: "login-error.png" }],
        fallbackLabels: ["Terminal 1"],
      }),
    ).toBe("Investigate login failures");
  });

  it("uses the first attachment name when text is empty", () => {
    expect(
      deriveThreadTitleSeed({
        text: " \n ",
        attachments: [{ name: "login-error.png" }, { name: "other.png" }],
      }),
    ).toBe("Image: login-error.png");
  });

  it("uses the first non-empty fallback label after text and attachments", () => {
    expect(
      deriveThreadTitleSeed({
        text: "",
        attachments: [],
        fallbackLabels: [null, "  ", "Terminal 1"],
      }),
    ).toBe("Terminal 1");
  });

  it("falls back to New thread", () => {
    expect(deriveThreadTitleSeed({ text: "", attachments: [] })).toBe("New thread");
  });

  it("applies the shared title truncation", () => {
    expect(
      deriveThreadTitleSeed({
        text: "x".repeat(60),
        attachments: [],
      }),
    ).toBe(`${"x".repeat(50)}...`);
  });
});
