import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads contracts and validates monograms without Intl.Segmenter", async () => {
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  vi.resetModules();

  const { ProjectMonogramText } = await import("./index.ts");
  const Schema = await import("effect/Schema");
  const isMonogram = Schema.is(ProjectMonogramText);

  for (const text of ["A", "T3", "e\u0301", "किखि", "\u1100\u1161\u11a8", "𐐀𐐁", "A\u200dB"]) {
    expect(isMonogram(text), text).toBe(true);
  }
  for (const text of ["", "ABC", "किखिगि", "\u0301", "A B", "🚀"]) {
    expect(isMonogram(text), text).toBe(false);
  }

  // The lightweight limit counts consonants separately in complex Indic conjuncts.
  expect(isMonogram("क्ष्म")).toBe(false);
  expect(isMonogram("A\u200dB\u200dC")).toBe(false);
});
