import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { buildOverriddenFileDiff, reconstructPreTurnFileContents } from "./diffFileEditOverrides";

function getSingleFileDiff(patch: string) {
  const parsed = parsePatchFiles(patch, "diff-file-edit-overrides:test");
  const fileDiff = parsed.flatMap((entry) => entry.files)[0];
  if (!fileDiff) {
    throw new Error("Expected patch to include one file diff.");
  }
  return fileDiff;
}

describe("diffFileEditOverrides", () => {
  it("reconstructs pre-turn file contents from the saved post-turn file", () => {
    const fileDiff = getSingleFileDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,4 @@
 const one = 1;
-const two = 2;
+const two = 3;
+const three = 4;
 export {};
`);

    const postTurnContents = [
      "const one = 1;\n",
      "const two = 3;\n",
      "const three = 4;\n",
      "export {};\n",
    ].join("");

    expect(reconstructPreTurnFileContents(fileDiff, postTurnContents)).toBe(
      ["const one = 1;\n", "const two = 2;\n", "export {};\n"].join(""),
    );
  });

  it("builds a renderable diff from the stored override contents", () => {
    const overridden = buildOverriddenFileDiff("src/example.ts", {
      preTurnContents: "const answer = 1;\n",
      savedContents: "const answer = 2;\nconst extra = true;\n",
    });

    expect(overridden).not.toBeNull();
    expect(overridden?.name).toContain("src/example.ts");
    expect(overridden?.additionLines.join("")).toContain("const answer = 2;");
    expect(overridden?.additionLines.join("")).toContain("const extra = true;");
  });
});
