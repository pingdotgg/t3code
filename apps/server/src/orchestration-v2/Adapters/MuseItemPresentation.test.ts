import { describe, expect, it } from "@effect/vitest";

import type { MuseItem } from "../../provider/museProtocol.ts";
import { museItemStatus, museToolPresentation } from "./MuseItemPresentation.ts";

const item = (fields: Partial<MuseItem>): MuseItem => ({
  itemId: "native-item",
  kind: "toolCall",
  status: "completed",
  revision: 1,
  ...fields,
});

describe("Muse item presentation", () => {
  it("preserves an edit's file and exact old/new text for the shared diff UI", () => {
    expect(
      museToolPresentation(
        item({
          tool: "edit_file",
          args: JSON.stringify({ file_path: "src/index.ts", old_string: "old\n", new_string: "" }),
        }),
      ),
    ).toMatchObject({
      type: "file_change",
      status: "completed",
      fileName: "src/index.ts",
      oldStr: "old\n",
      newStr: "",
    });
  });

  it("preserves write content and provider-supplied patches", () => {
    expect(
      museToolPresentation(
        item({
          tool: "write_file",
          args: JSON.stringify({ path: "README.md", content: "Hello\n" }),
        }),
      ),
    ).toMatchObject({ type: "file_change", newStr: "Hello\n" });
    expect(
      museToolPresentation(
        item({
          tool: "apply_patch",
          args: JSON.stringify({ path: "README.md", patch: "@@ -1 +1 @@\n-old\n+new" }),
        }),
      ),
    ).toMatchObject({ type: "file_change", diffStr: "@@ -1 +1 @@\n-old\n+new" });
  });

  it("keeps malformed edit arguments visible without inventing a file", () => {
    expect(
      museToolPresentation(
        item({ tool: "edit_file", args: "incomplete {", visibleOutput: "Needs more input" }),
      ),
    ).toMatchObject({ type: "dynamic_tool", input: "incomplete {", output: "Needs more input" });
  });

  it("extracts shell commands and retains native output and exit codes", () => {
    expect(
      museToolPresentation(
        item({
          tool: "shell",
          args: JSON.stringify({ command: "git status" }),
          visibleOutput: "working tree clean",
          exitCode: 0,
        }),
      ),
    ).toMatchObject({
      type: "command_execution",
      input: "git status",
      output: "working tree clean",
      exitCode: 0,
    });
    expect(
      museToolPresentation(
        item({ kind: "userShell", commandText: "pwd", args: JSON.stringify({ cmd: "ignored" }) }),
      ),
    ).toMatchObject({ input: "pwd" });
  });

  it.each(["rejected", "timedOut", "handedOff"])(
    "does not report native %s activity as successful",
    (status) => {
      const native = item({ tool: "search_files", status, fallbackText: "Native explanation" });
      expect(museItemStatus(native)).toBe("failed");
      expect(museToolPresentation(native)).toMatchObject({
        status: "failed",
        output: `Muse reported ${status}.\nNative explanation`,
      });
    },
  );

  it("preserves failure details and a known cancelled status", () => {
    expect(
      museToolPresentation(
        item({
          status: "failed",
          failureReason: "Permission denied",
          visibleOutput: "Partial output",
        }),
      ),
    ).toMatchObject({ status: "failed", output: "Permission denied\nPartial output" });
    expect(museItemStatus(item({ status: "cancelled" }))).toBe("cancelled");
  });

  it.each(["failed", "noop"])(
    "keeps %s compaction outcomes from appearing completed",
    (outcome) => {
      expect(museItemStatus(item({ kind: "compaction", outcome }))).toBe("failed");
    },
  );

  it("keeps reminder and native child summaries as neutral activity", () => {
    expect(
      museToolPresentation(item({ kind: "reminderChild", fallbackText: "Reminder child session" })),
    ).toMatchObject({ type: "dynamic_tool", title: "Reminder", output: "Reminder child session" });
    expect(
      museToolPresentation(
        item({ kind: "subagent", objective: "Review patch", result: { summary: "No issues" } }),
      ),
    ).toMatchObject({ type: "dynamic_tool", title: "Review patch", output: "No issues" });
  });

  it("preserves web query and output without manufacturing result links", () => {
    expect(
      museToolPresentation(
        item({
          tool: "web_search",
          args: JSON.stringify({ query: "Muse docs" }),
          visibleOutput: "Native result text",
        }),
      ),
    ).toMatchObject({
      type: "web_search",
      patterns: ["Muse docs"],
      results: [{ snippet: "Native result text" }],
    });
  });

  it("preserves image tool details through V2's generic tool surface", () => {
    expect(
      museToolPresentation(
        item({
          tool: "view_image",
          args: JSON.stringify({ path: "/tmp/chart.png" }),
          visibleOutput: "Image displayed",
        }),
      ),
    ).toMatchObject({
      type: "dynamic_tool",
      input: { path: "/tmp/chart.png" },
      output: "Image displayed",
    });
  });
});
