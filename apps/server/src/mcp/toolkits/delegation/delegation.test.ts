import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Tool } from "effect/unstable/ai";

import { DelegateWorkTool, DelegateWorkToolInput } from "./tools.ts";

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

  it("rejects whitespace-only model, project, branch, and path values", () => {
    const base = { children: [{ title: "x", prompt: "y" }] };
    expect(decodeSucceeds({ ...base, defaults: { model: "  " } })).toBe(false);
    expect(decodeSucceeds({ ...base, defaults: { project: " " } })).toBe(false);
    expect(
      decodeSucceeds({
        children: [
          { title: "x", prompt: "y", workspace: { mode: "isolated", branch: " ", path: "/p" } },
        ],
      }),
    ).toBe(false);
    expect(
      decodeSucceeds({
        children: [
          { title: "x", prompt: "y", workspace: { mode: "isolated", branch: "child", path: "  " } },
        ],
      }),
    ).toBe(false);
  });

  it("rejects unknown, duplicate, and empty prompt template blocks", () => {
    const base = { children: [{ title: "x", prompt: "y" }] };
    expect(
      decodeSucceeds({ ...base, defaults: { promptTemplate: { blocks: ["implementation"] } } }),
    ).toBe(true);
    expect(
      decodeSucceeds({ ...base, defaults: { promptTemplate: { blocks: ["not-a-block"] } } }),
    ).toBe(false);
    expect(
      decodeSucceeds({
        ...base,
        defaults: { promptTemplate: { blocks: ["commit", "commit"] } },
      }),
    ).toBe(false);
    expect(decodeSucceeds({ ...base, defaults: { promptTemplate: { blocks: [] } } })).toBe(false);
  });

  it("rejects duplicate prompt template evidence entries", () => {
    expect(
      decodeSucceeds({
        children: [{ title: "x", prompt: "y" }],
        defaults: {
          promptTemplate: {
            blocks: ["validation"],
            validation: {
              commands: ["pnpm test"],
              evidence: ["screenshot", "screenshot"],
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("advertises the constrained prompt template contract to strict clients", () => {
    // Strict MCP clients validate the advertised schema; if the enum or the
    // uniqueness constraint were dropped here, only runtime would reject them.
    const advertised = JSON.stringify(Tool.getJsonSchema(DelegateWorkTool));
    expect(advertised).toContain("push-and-create-pr");
    expect(advertised).toContain("uniqueItems");
  });
});
