import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("lathe/no-raw-resize-observer");

describe("lathe/no-raw-resize-observer", () => {
  rule.valid(
    "allows ResizeObserver types and feature detection",
    `
      let observer: ResizeObserver | null = null;
      export const supported = typeof ResizeObserver !== "undefined";
      export const entries: ResizeObserverEntry[] = [];
    `,
  );

  rule.valid(
    "allows other DOM observers",
    `export const observer = new MutationObserver(() => {});`,
  );

  rule.invalid(
    "reports a direct ResizeObserver construction",
    `export const observer = new ResizeObserver(() => {});`,
  );

  rule.invalid(
    "reports construction through a global object",
    `export const observer = new window.ResizeObserver(() => {});`,
  );

  rule.invalid(
    "reports computed construction through a global object",
    `export const observer = new globalThis["ResizeObserver"](() => {});`,
  );
});
