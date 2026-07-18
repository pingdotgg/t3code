import { describe, expect, it } from "vite-plus/test";

import {
  mergeCumulativeOutput,
  mergeCumulativePatch,
  parseWorkLogActivityPayload,
  requestKindFromRequestType,
} from "./workLogActivity";

describe("parseWorkLogActivityPayload", () => {
  it("normalizes command, result, patch, and changed-file provider payloads", () => {
    const parsed = parseWorkLogActivityPayload(
      {
        itemType: "command_execution",
        title: "Ran command",
        data: {
          toolCallId: "command-1",
          item: {
            command: ["pwsh", "-Command", "vp test"],
            result: {
              stdout: "passed\n",
              stderr: "warning\n",
              exitCode: 0,
              durationMs: 125,
              changes: [
                {
                  path: "apps/web/src/example.ts",
                  diff: "@@ -1 +1 @@\n-old\n+new",
                },
              ],
            },
          },
        },
      },
      { heading: "Ran command" },
    );

    expect(parsed).toMatchObject({
      command: "vp test",
      rawCommand: 'pwsh -Command "vp test"',
      stdout: "passed\n",
      stderr: "warning\n",
      exitCode: 0,
      durationMs: 125,
      changedFiles: ["apps/web/src/example.ts"],
      title: "Ran command",
      toolCallId: "command-1",
      itemType: "command_execution",
    });
    expect(parsed.patch).toContain("diff --git a/apps/web/src/example.ts");
    expect(parsed.patch).toContain("@@ -1 +1 @@");
  });

  it("preserves blank incremental streams while ignoring blank completed fallbacks", () => {
    const payload = {
      itemType: "command_execution",
      data: {
        rawOutput: {
          stdout: "   ",
          content: "\n",
        },
        item: {
          output: "aggregated output",
        },
      },
    };

    expect(
      parseWorkLogActivityPayload(payload, {
        heading: "Ran command",
        preserveBlankRawOutputStreams: true,
      }),
    ).toMatchObject({ stdout: "   ", output: "   " });
    expect(parseWorkLogActivityPayload(payload, { heading: "Ran command" })).toMatchObject({
      stdout: null,
      output: "aggregated output",
    });
  });
});

describe("cumulative activity snapshots", () => {
  it("replaces cumulative patch prefixes and joins independent patches", () => {
    expect(mergeCumulativePatch("@@ -1 +1 @@\n-old", "@@ -1 +1 @@\n-old\n+new")).toBe(
      "@@ -1 +1 @@\n-old\n+new",
    );
    expect(mergeCumulativePatch("patch one", "patch two")).toBe("patch one\n\npatch two");
  });

  it("keeps shorter snapshots but concatenates incremental output chunks", () => {
    expect(mergeCumulativeOutput("first line\nsecond", "first line", "tool.completed")).toBe(
      "first line\nsecond",
    );
    expect(mergeCumulativeOutput("abc", "d", "tool.updated")).toBe("abcd");
    expect(mergeCumulativeOutput("abc", "abcd", "tool.updated")).toBe("abcd");
  });
});

describe("requestKindFromRequestType", () => {
  it("maps provider approval request types without broadening unknown values", () => {
    expect(requestKindFromRequestType("exec_command_approval")).toBe("command");
    expect(requestKindFromRequestType("file_read_approval")).toBe("file-read");
    expect(requestKindFromRequestType("apply_patch_approval")).toBe("file-change");
    expect(requestKindFromRequestType("other")).toBeNull();
  });
});
