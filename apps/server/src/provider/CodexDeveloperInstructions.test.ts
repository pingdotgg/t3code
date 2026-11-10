import * as NodeAssert from "node:assert/strict";

import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  buildCodexAppContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
  CODEX_APP_CONTEXT_MAX_TOTAL_BYTES,
} from "./CodexDeveloperInstructions.ts";

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}

describe("buildCodexAdditionalContext", () => {
  it.each([undefined, { browser: true, device: true }])(
    "keeps every entry within Codex's per-entry cap with tools %j",
    (availability) => {
      const context = buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, availability);

      for (const [key, entry] of Object.entries(context)) {
        // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
        const bytes = Buffer.byteLength(entry.value, "utf8");
        const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
        NodeAssert.ok(
          bytes <= limit,
          `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
        );
      }
    },
  );
});

describe("Codex runtime context", () => {
  it("describes Markdown media support in the runtime context in both modes", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images, video, and audio.*Markdown image syntax with absolute file paths.*Link any other file.*absolute path.*files viewer.*<\/runtime_info>/,
      );
    }
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex/);
    NodeAssert.doesNotMatch(instructions, /reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes same-child follow-ups to t3_thread_send and independent reviews to delegate_task", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(
      orchestration.includes("Background agent: `delegate_task`, never a background `Agent`."),
    );
    NodeAssert.ok(
      orchestration.includes(
        "For independent T3 delegated review rounds, call `delegate_task` again.",
      ),
    );
    NodeAssert.ok(
      orchestration.includes(
        "For a follow-up that needs the same child's conversation, use `t3_thread_send` on its `childThreadId`.",
      ),
    );
    NodeAssert.ok(!orchestration.includes("Do not use `t3_thread_send`"));
  });
});

describe("buildCodexAppContext", () => {
  it("keeps the most recently updated apps within the aggregate budget", () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({
      key: `mcp_app_${index}`,
      text: String(index).repeat(CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES),
    }));

    const context = buildCodexAppContext(entries);

    NodeAssert.deepEqual(Object.keys(context), [
      "mcp_app_2",
      "mcp_app_3",
      "mcp_app_4",
      "mcp_app_5",
    ]);
    const total = Object.values(context).reduce(
      (bytes, entry) => bytes + Buffer.byteLength(entry.value, "utf8"),
      0,
    );
    NodeAssert.ok(total <= CODEX_APP_CONTEXT_MAX_TOTAL_BYTES);
    NodeAssert.ok(Object.values(context).every((entry) => entry.kind === "untrusted"));
  });

  it("cuts the middle of an oversized value on a character boundary", () => {
    const text = `start ${"🦊".repeat(4_000)} end`;

    const value = buildCodexAppContext([{ key: "mcp_app_fox", text }]).mcp_app_fox!.value;

    NodeAssert.ok(Buffer.byteLength(value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES);
    NodeAssert.ok(value.startsWith("start 🦊"));
    NodeAssert.ok(value.endsWith("🦊 end"));
    NodeAssert.ok(value.includes("[truncated]"));
    NodeAssert.ok(!value.includes("\uFFFD"));
  });

  it("passes values within the per-entry cap through unchanged", () => {
    NodeAssert.deepEqual(buildCodexAppContext([{ key: "mcp_app_a", text: "Filtered" }]), {
      mcp_app_a: { kind: "untrusted", value: "Filtered" },
    });
  });
});

describe("Codex device context", () => {
  it("adds the shared device block only when the session holds device access", () => {
    const tools = (device: boolean) =>
      buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, { browser: true, device }).t3_code_tools
        ?.value ?? "";

    NodeAssert.ok(tools(true).includes(T3_CODE_DEVICE_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(true).includes("ToolSearch"));
    NodeAssert.ok(!tools(false).includes("## T3 Code devices"));
  });
});
