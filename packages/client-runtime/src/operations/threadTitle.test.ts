import { describe, expect, it } from "@effect/vitest";

import { deriveThreadTitleSeed } from "./threadTitle.ts";

describe("deriveThreadTitleSeed", () => {
  const image = "![pasted-image.png](t3-context://v1/image/aadd9cc6-1234-5678-9012-abcdef123456)";

  it.each([{ attachments: [] }, { attachments: [{ name: "pasted-image.png" }] }])(
    "uses a readable image-only title with attachments $attachments",
    ({ attachments }) => {
      expect(deriveThreadTitleSeed({ text: image, attachments })).toBe("Attached image");
    },
  );

  it.each([`${image}\nFix the spacing`, `Fix ${image} the spacing`])(
    "prefers prose around image references: %s",
    (text) => {
      expect(deriveThreadTitleSeed({ text, attachments: [] })).toBe("Fix the spacing");
    },
  );

  it("uses a plural placeholder for several images", () => {
    expect(
      deriveThreadTitleSeed({
        text: `${image}\n![other.png](t3-context://v1/image/other)`,
        attachments: [],
      }),
    ).toBe("Attached images");
  });

  it("counts repeated references to the same image once", () => {
    expect(deriveThreadTitleSeed({ text: `${image}\n${image}`, attachments: [] })).toBe(
      "Attached image",
    );
  });

  it("keeps context labels without exposing their internal URLs", () => {
    expect(
      deriveThreadTitleSeed({
        text: `${image} Fix [src/app.ts](t3-context://v1/mention/source) using [Build output](t3-context://v1/terminal/build)`,
        attachments: [],
      }),
    ).toBe("Fix src/app.ts using Build output");
  });

  it("prefers a source reference label over the image placeholder without prose", () => {
    expect(
      deriveThreadTitleSeed({
        text: `${image}\n[src/app.ts](t3-context://v1/mention/source)`,
        attachments: [{ name: "pasted-image.png" }],
      }),
    ).toBe("src/app.ts");
  });

  it("prefers normalized message text", () => {
    expect(
      deriveThreadTitleSeed({
        text: "  Investigate\n  login   failures  ",
        attachments: [{ name: "login-error.png" }],
        fallbackLabels: ["Terminal 1"],
      }),
    ).toBe("Investigate login failures");
  });

  it.each([1, 2])("uses a placeholder for %i attachments when text is empty", (count) => {
    expect(
      deriveThreadTitleSeed({
        text: " \n ",
        attachments: [{ name: "login-error.png" }, { name: "other.png" }].slice(0, count),
      }),
    ).toBe(count === 1 ? "Attached image" : "Attached images");
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
