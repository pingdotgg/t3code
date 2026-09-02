import { describe, expect, it } from "vite-plus/test";

import {
  boundToolOutput,
  deriveToolCallFacts,
  textPairStat,
  TOOL_OUTPUT_MAX_LINES,
  unifiedDiffStat,
} from "./toolCallFacts.ts";

const DIFF = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import x from "x";
-const a = 1;
+const a = 2;
+const b = 3;
`;

describe("deriveToolCallFacts", () => {
  it("reads Codex command items verbatim", () => {
    expect(
      deriveToolCallFacts({
        provider: "codex",
        data: {
          item: {
            type: "commandExecution",
            command: "pnpm test",
            cwd: "/repo/apps/web",
            exitCode: 1,
            durationMs: 4210,
            aggregatedOutput: "FAIL src/a.test.ts\n  expected 1 to be 2\n",
          },
        },
      }),
    ).toEqual({
      cwd: "/repo/apps/web",
      exitCode: 1,
      durationMs: 4210,
      output: { text: "FAIL src/a.test.ts\n  expected 1 to be 2", lineCount: 2, truncated: false },
    });
  });

  it("keeps Codex file changes with diff stats and a bounded hunk", () => {
    const facts = deriveToolCallFacts({
      provider: "codex",
      data: {
        item: { type: "fileChange", changes: [{ path: "src/app.ts", kind: "update", diff: DIFF }] },
      },
    });
    expect(facts?.files).toEqual([
      { path: "src/app.ts", kind: "update", additions: 2, deletions: 1, diff: DIFF },
    ]);
  });

  it("reads Claude Bash intent and tool_result text", () => {
    expect(
      deriveToolCallFacts({
        provider: "claudeAgent",
        data: {
          toolName: "Bash",
          input: { command: "ls", description: "List the project root" },
          result: {
            type: "tool_result",
            content: [{ type: "text", text: "a\nb" }],
            is_error: false,
          },
        },
      }),
    ).toEqual({
      intent: "List the project root",
      output: { text: "a\nb", lineCount: 2, truncated: false },
    });
  });

  it("derives edit stats for Claude Edit and Write calls", () => {
    expect(
      deriveToolCallFacts({
        provider: "claudeAgent",
        data: {
          toolName: "Edit",
          input: { file_path: "/repo/a.ts", old_string: "x\ny", new_string: "x\nz\nw" },
        },
      })?.files,
    ).toEqual([{ path: "/repo/a.ts", kind: "update", additions: 2, deletions: 1 }]);
    expect(
      deriveToolCallFacts({
        provider: "claudeAgent",
        data: { toolName: "Write", input: { file_path: "/repo/b.ts", content: "1\n2\n3" } },
      })?.files,
    ).toEqual([{ path: "/repo/b.ts", kind: "write", additions: 3, deletions: 0 }]);
  });

  it("reads ACP content text and diff parts for Cursor and Grok", () => {
    const data = {
      kind: "edit",
      content: [
        { type: "content", content: { type: "text", text: "Applied" } },
        { type: "diff", path: "src/x.ts", oldText: "a\nb", newText: "a\nc" },
      ],
    };
    for (const provider of ["cursor", "grok"]) {
      expect(deriveToolCallFacts({ provider, data })).toEqual({
        output: { text: "Applied", lineCount: 1, truncated: false },
        files: [{ path: "src/x.ts", additions: 1, deletions: 1 }],
      });
    }
  });

  it("reads OpenCode state timing, output, and exit metadata", () => {
    expect(
      deriveToolCallFacts({
        provider: "opencode",
        data: {
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "make" },
            output: "ok",
            metadata: { exit: 0 },
            time: { start: 1000, end: 1750 },
          },
        },
      }),
    ).toEqual({
      exitCode: 0,
      durationMs: 750,
      output: { text: "ok", lineCount: 1, truncated: false },
    });
  });

  it("returns nothing for unknown providers or empty data", () => {
    expect(deriveToolCallFacts({ provider: "codex", data: {} })).toBeUndefined();
    expect(deriveToolCallFacts({ provider: "other", data: { item: {} } })).toBeUndefined();
  });
});

describe("boundToolOutput", () => {
  it("caps lines, strips ANSI, and reports the real size", () => {
    const raw = Array.from({ length: 100 }, (_, i) => `[32mline ${i}[0m`).join("\n");
    const output = boundToolOutput(raw);
    expect(output?.lineCount).toBe(100);
    expect(output?.truncated).toBe(true);
    expect(output?.text.split("\n")).toHaveLength(TOOL_OUTPUT_MAX_LINES);
    expect(output?.text.startsWith("line 0")).toBe(true);
  });

  it("drops empty output", () => {
    expect(boundToolOutput("  \n ")).toBeUndefined();
    expect(boundToolOutput(undefined)).toBeUndefined();
  });
});

describe("diff stats", () => {
  it("counts unified diff lines without headers", () => {
    expect(unifiedDiffStat(DIFF)).toEqual({ additions: 2, deletions: 1 });
  });

  it("counts before/after line changes", () => {
    expect(textPairStat("a\nb\nc", "a\nc\nd")).toEqual({ additions: 1, deletions: 1 });
    expect(textPairStat("", "one\ntwo")).toEqual({ additions: 2, deletions: 0 });
  });
});
