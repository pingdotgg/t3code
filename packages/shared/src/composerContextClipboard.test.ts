import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "./composerContextClipboard.ts";

describe("composerContextClipboard", () => {
  it("round-trips selections larger than two million characters", () => {
    const fragment = {
      version: 1 as const,
      source: { environmentId: "env" as never },
      records: Array.from({ length: 32 }, (_, index) => ({
        version: 1 as const,
        contextId: `terminal-${index}` as never,
        kind: "terminal" as const,
        label: "Build",
        terminalId: "build",
        terminalLabel: "Build",
        lineStart: 1,
        lineEnd: 1,
        text: "x".repeat(64_000),
      })),
    };
    const encoded = encodeComposerContextFragment(fragment);
    expect(encoded?.length).toBeGreaterThan(2_000_000);
    expect(decodeComposerContextFragment(encoded)).toEqual(fragment);
    expect(
      encodeComposerContextFragment({
        ...fragment,
        records: Array.from({ length: 200 }, () => ({
          ...fragment.records[0]!,
          text: "\u0000".repeat(64_000),
        })),
      }),
    ).toBeNull();
  });
  it("round-trips a fragment and drops records it cannot decode", () => {
    const encoded = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: "env-1" as never, threadId: "thread-1" as never },
      records: [
        { version: 1, contextId: "ctx-1" as never, kind: "skill", label: "$x", name: "x" },
        { version: 1, contextId: "ctx-2" as never, kind: "image", label: "bad" } as never,
      ],
    });
    const decoded = decodeComposerContextFragment(encoded);
    expect(decoded?.source.threadId).toBe("thread-1");
    expect(decoded?.records.map((record) => record.contextId)).toEqual(["ctx-1"]);
  });

  it("rejects garbage, other versions, and oversized payloads", () => {
    expect(decodeComposerContextFragment(null)).toBeNull();
    expect(decodeComposerContextFragment("not json")).toBeNull();
    expect(
      decodeComposerContextFragment(
        JSON.stringify({ version: 2, source: { environmentId: "e" }, records: [] }),
      ),
    ).toBeNull();
    expect(decodeComposerContextFragment("x".repeat(2_000_001))).toBeNull();
    expect(COMPOSER_CONTEXT_CLIPBOARD_MIME).toMatch(/^web application\//);
  });
});
