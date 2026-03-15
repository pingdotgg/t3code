import { describe, expect, it } from "vitest";

import { buildThreadTitle } from "./threadTitle";

describe("buildThreadTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(buildThreadTitle("   hello world   ")).toBe("hello world");
  });

  it("returns trimmed text when within max length", () => {
    expect(buildThreadTitle("alpha", 10)).toBe("alpha");
  });

  it("appends ellipsis when text exceeds max length", () => {
    expect(buildThreadTitle("abcdefghij", 5)).toBe("abcde...");
  });

  it("shortens a single file mention to its basename while keeping the marker", () => {
    expect(buildThreadTitle("Inspect @apps/web/src/components/ChatView.tsx please")).toBe(
      "Inspect @ChatView.tsx please",
    );
  });

  it("shortens multiple file mentions independently", () => {
    expect(buildThreadTitle("Compare @apps/web/src/a.ts with @packages/shared/src/b.ts now")).toBe(
      "Compare @a.ts with @b.ts now",
    );
  });

  it("shortens mentions before truncating the title", () => {
    const title = buildThreadTitle(
      "@apps/web/src/components/ChatView.tsx investigate header layout",
      20,
    );

    expect(title).toBe("@ChatView.tsx invest...");
    expect(title).not.toContain("apps/web/src/components");
  });

  it("leaves incomplete trailing mentions unchanged", () => {
    expect(buildThreadTitle("Inspect @apps/web/src/components/ChatView.tsx")).toBe(
      "Inspect @apps/web/src/components/ChatView.tsx",
    );
  });

  it("preserves punctuation and whitespace around mention segments", () => {
    expect(
      buildThreadTitle(
        "Review @apps/web/src/components/ChatView.tsx ; then ping @README.md please",
      ),
    ).toBe("Review @ChatView.tsx ; then ping @README.md please");
  });
});
