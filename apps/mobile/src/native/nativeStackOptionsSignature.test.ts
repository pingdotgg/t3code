import { describe, expect, it } from "vite-plus/test";

import { buildNativeStackOptionsSignature } from "./nativeStackOptionsSignature";

describe("buildNativeStackOptionsSignature", () => {
  it("treats fresh object/function identities with the same content as equal", () => {
    const items = [
      {
        identifier: "thread-right-git",
        label: "Git",
        type: "button",
      },
    ];

    const first = buildNativeStackOptionsSignature({
      headerTitle: "Catch-up thread",
      title: "Catch-up thread",
      headerBackVisible: true,
      unstable_headerRightItems: () => items,
      unstable_headerSubtitle: "proj · env",
    });
    const second = buildNativeStackOptionsSignature({
      headerTitle: "Catch-up thread",
      title: "Catch-up thread",
      headerBackVisible: true,
      unstable_headerRightItems: () => items,
      unstable_headerSubtitle: "proj · env",
    });

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it("changes when title or item content changes", () => {
    const base = buildNativeStackOptionsSignature({
      headerTitle: "A",
      unstable_headerRightItems: () => [{ identifier: "a", type: "button" }],
    });
    const renamed = buildNativeStackOptionsSignature({
      headerTitle: "B",
      unstable_headerRightItems: () => [{ identifier: "a", type: "button" }],
    });
    const reitemed = buildNativeStackOptionsSignature({
      headerTitle: "A",
      unstable_headerRightItems: () => [{ identifier: "b", type: "button" }],
    });

    expect(renamed).not.toBe(base);
    expect(reitemed).not.toBe(base);
  });

  it("ignores function-only differences inside header items", () => {
    const withPressA = buildNativeStackOptionsSignature({
      unstable_headerRightItems: () => [
        {
          identifier: "x",
          onPress: () => "a",
          type: "button",
        },
      ],
    });
    const withPressB = buildNativeStackOptionsSignature({
      unstable_headerRightItems: () => [
        {
          identifier: "x",
          onPress: () => "b",
          type: "button",
        },
      ],
    });

    expect(withPressA).toBe(withPressB);
  });
});
