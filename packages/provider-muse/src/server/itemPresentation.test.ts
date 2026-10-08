import { describe, expect, it } from "@effect/vitest";

import type { MuseItem } from "./protocol.ts";
import { museItemStatus, museToolPresentation } from "./itemPresentation.ts";

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
});
