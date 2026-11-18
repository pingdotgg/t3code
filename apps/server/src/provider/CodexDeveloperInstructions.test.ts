import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  it("keeps every entry within Codex's per-entry cap", () => {
    const context = buildCodexAdditionalContext({
      model: "custom-model",
      modelName: "Custom 🦊 Model",
      reasoningEffort: "xhigh",
    });

    for (const [key, entry] of Object.entries(context)) {
      // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
      const bytes = Buffer.byteLength(entry.value, "utf8");
      const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
      NodeAssert.ok(
        bytes <= limit,
        `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
      );
    }
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexAdditionalContext({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    }).t3_code_runtime!.value;

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });

  it("carries no T3 tool guidance", () => {
    const context = JSON.stringify(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }));

    NodeAssert.ok(!context.includes("delegate_task"));
    NodeAssert.ok(!context.includes("link_pull_request"));
    NodeAssert.ok(!context.includes("device_open"));
  });
});
