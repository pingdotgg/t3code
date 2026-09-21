import { COMPOSER_CONTEXT_KINDS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONTEXT_PRESENTATION_DEFINITIONS,
  contextPresentationDefinition,
  createContextPresentationRegistry,
} from "./contextPresentationRegistry";

describe("contextPresentationRegistry", () => {
  it("defines presentation capabilities for every known context kind", () => {
    expect([...CONTEXT_PRESENTATION_DEFINITIONS.keys()]).toEqual(COMPOSER_CONTEXT_KINDS);
    expect(contextPresentationDefinition("terminal").capabilities).toEqual({
      details: "popover",
      expanded: "none",
      defaultDraftView: "compact",
    });
  });

  it("rejects duplicate handlers for one surface", () => {
    expect(() =>
      createContextPresentationRegistry<string, undefined, string>({
        handlers: [
          { kind: "terminal", render: () => "first" },
          { kind: "terminal", render: () => "second" },
        ],
        fallback: () => "fallback",
      }),
    ).toThrowError("Duplicate context presentation handler: terminal");
  });

  it("rejects a missing handler required by a surface", () => {
    expect(() =>
      createContextPresentationRegistry<string, undefined, string>({
        handlers: [{ kind: "terminal", render: () => "terminal" }],
        requiredKinds: ["terminal", "review-comment"],
        fallback: () => "fallback",
      }),
    ).toThrowError("Missing context presentation handler: review-comment");
  });

  it("uses the explicit fallback for unknown, missing, and mismatched records", () => {
    const registry = createContextPresentationRegistry<string, undefined, string>({
      handlers: [
        {
          kind: "terminal",
          canRender: (record) => record === "terminal",
          render: () => "rendered",
        },
      ],
      fallback: (kind) => `fallback:${kind}`,
    });

    expect(registry.render("terminal", "terminal", undefined)).toBe("rendered");
    expect(registry.render("terminal", "file", undefined)).toBe("fallback:terminal");
    expect(registry.render("terminal", undefined, undefined)).toBe("fallback:terminal");
    expect(registry.render("future-kind", "payload", undefined)).toBe("fallback:future-kind");
  });
});
