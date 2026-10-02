import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { DelegateWorkToolInput } from "./tools.ts";

const decodeInput = Schema.decodeUnknownSync(DelegateWorkToolInput);

const decodeSucceeds = (input: unknown): boolean => {
  try {
    decodeInput(input);
    return true;
  } catch {
    return false;
  }
};

describe("DelegateWorkToolInput", () => {
  it("accepts a minimal child with only title and prompt", () => {
    expect(
      decodeSucceeds({ children: [{ title: "haiku-check", prompt: "Reply pineapple." }] }),
    ).toBe(true);
  });

  it("rejects a missing children array", () => {
    expect(decodeSucceeds({})).toBe(false);
  });

  it("rejects an empty title or prompt", () => {
    expect(decodeSucceeds({ children: [{ title: "", prompt: "x" }] })).toBe(false);
    expect(decodeSucceeds({ children: [{ title: "x", prompt: "  " }] })).toBe(false);
  });

  it("rejects more than sixteen children", () => {
    const children = Array.from({ length: 17 }, (_, index) => ({
      title: `child-${index}`,
      prompt: "do it",
    }));
    expect(decodeSucceeds({ children })).toBe(false);
  });

  it("rejects an unknown wait policy and out-of-range concurrency", () => {
    const base = { children: [{ title: "x", prompt: "y" }] };
    expect(decodeSucceeds({ ...base, wait: "eventually" })).toBe(false);
    expect(decodeSucceeds({ ...base, concurrency: 0 })).toBe(false);
    expect(decodeSucceeds({ ...base, concurrency: 5 })).toBe(false);
  });

  it("accepts shared defaults with per-child overrides", () => {
    expect(
      decodeSucceeds({
        defaults: { model: "gpt-6-luna", followUp: "automatic" },
        children: [{ title: "x", prompt: "y", model: "other-model" }],
        wait: "all",
        concurrency: 2,
      }),
    ).toBe(true);
  });
});
