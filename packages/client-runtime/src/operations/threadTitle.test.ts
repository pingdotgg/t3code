import { describe, expect, it } from "@effect/vitest";

import { deriveThreadTitleSeed } from "./threadTitle.ts";

describe("deriveThreadTitleSeed", () => {
  const image = "![pasted-image.png](t3-context://v1/image/aadd9cc6-1234-5678-9012-abcdef123456)";

  it.each([
    [image, "Attached image"],
    [`${image}\n![other.png](t3-context://v1/image/other)`, "Attached images"],
  ])("uses a readable image-only title for %s", (text, title) => {
    expect(deriveThreadTitleSeed({ text, attachments: [] })).toBe(title);
  });

  it("prefers a source label when an image prompt has no prose", () => {
    expect(
      deriveThreadTitleSeed({
        text: `${image}\n[src/app.ts](t3-context://v1/mention/source)`,
        attachments: [{ type: "image", name: "pasted-image.png" }],
      }),
    ).toBe("src/app.ts");
  });

  it("prefers normalized request text and context labels over attachments", () => {
    expect(
      deriveThreadTitleSeed({
        text: `  Fix ${image} [src/app.ts](t3-context://v1/mention/source)\n  using [Build output](t3-context://v1/terminal/build)  `,
        attachments: [{ type: "image", name: "login-error.png" }],
        fallbackLabels: ["Terminal 1"],
      }),
    ).toBe("Fix src/app.ts using Build output");
  });

  it("uses an image placeholder when text is empty", () => {
    expect(
      deriveThreadTitleSeed({
        text: " \n ",
        attachments: [{ type: "image", name: "login-error.png" }],
      }),
    ).toBe("Attached image");
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
