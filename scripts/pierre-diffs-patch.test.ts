// @effect-diagnostics nodeBuiltinImport:off - validates the shipped dependency patch as text.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

it("keeps Pierre diff patch hunk positions valid for forward and reverse application", () => {
  const patch = NodeFS.readFileSync(
    new URL("../patches/@pierre%252Fdiffs@1.3.0-beta.10.patch", import.meta.url),
    "utf8",
  ).concat("\ndiff --git a/single b/single\n@@ -4 +4 @@\n-old\n+new\n");

  for (const file of patch.split(/^diff --git /m).slice(1)) {
    let offset = 0;
    for (const hunk of file.split(/^@@ /m).slice(1)) {
      const [header, ...body] = hunk.split("\n");
      const match = header?.match(/^-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      expect(match).not.toBeNull();
      const [oldStart, oldCount, newStart, newCount] = match!
        .slice(1)
        .map((value) => Number(value ?? 1));
      expect(newStart, header).toBe(oldStart! + offset);
      expect(body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length).toBe(
        oldCount,
      );
      expect(body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length).toBe(
        newCount,
      );
      offset += newCount! - oldCount!;
    }
  }
});
