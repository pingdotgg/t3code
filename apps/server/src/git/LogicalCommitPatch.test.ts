import { describe, expect, it } from "vite-plus/test";

import {
  buildPatchForLogicalChangeUnits,
  parseLogicalChangeUnits,
  summarizeLogicalChangeUnits,
} from "./LogicalCommitPatch.ts";

const TWO_HUNK_PATCH = `diff --git a/src/example.ts b/src/example.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,4 @@
-const first = 1;
+const first = 2;
 const unchanged = true;
${" "}
 export { first };
@@ -20,4 +20,4 @@ export function later() {
-  return "old";
+  return "new";
 }
`;

describe("LogicalCommitPatch", () => {
  it("assigns stable IDs to independently applicable text hunks", () => {
    const units = parseLogicalChangeUnits(TWO_HUNK_PATCH);

    expect(units.map(({ id, filePath, kind }) => ({ id, filePath, kind }))).toEqual([
      { id: "H001", filePath: "src/example.ts", kind: "hunk" },
      { id: "H002", filePath: "src/example.ts", kind: "hunk" },
    ]);
    expect(summarizeLogicalChangeUnits(units)).toContain("H002\tsrc/example.ts\t@@ -20,4");
  });

  it("rebuilds a partial patch without a stale blob index", () => {
    const units = parseLogicalChangeUnits(TWO_HUNK_PATCH);
    const patch = buildPatchForLogicalChangeUnits([units[1]!]);

    expect(patch).toContain("diff --git a/src/example.ts b/src/example.ts");
    expect(patch).toContain("@@ -20,4 +20,4 @@");
    expect(patch).not.toContain("@@ -1,4 +1,4 @@");
    expect(patch).not.toContain("index 111111");
  });

  it("keeps new files and renames as indivisible units", () => {
    const patch = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
diff --git a/old.txt b/moved.txt
similarity index 100%
rename from old.txt
rename to moved.txt
`;

    expect(parseLogicalChangeUnits(patch).map((unit) => unit.kind)).toEqual([
      "whole-file",
      "whole-file",
    ]);
  });
});
