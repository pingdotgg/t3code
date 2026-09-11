import { describe, expect, it } from "vite-plus/test";
import { buildWorkspaceReviewDiff } from "./workspaceReviewDiff";

const diff = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-old
+new
`;

describe("workspace review diffs", () => {
  it("keeps same-named child files distinct with workspace-relative review paths", () => {
    const parsed = buildWorkspaceReviewDiff(
      [
        { path: "projects/api", diff },
        { path: "projects/web", diff },
      ],
      "thread",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files.map((file) => file.path)).toEqual([
      "projects/api/src/index.ts",
      "projects/web/src/index.ts",
    ]);
    expect(new Set(parsed.files.map((file) => file.id)).size).toBe(2);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(2);
  });
  it("preserves wrapper paths and empty workspace diffs", () => {
    const parsed = buildWorkspaceReviewDiff([{ path: ".", diff }], "thread");
    if (parsed.kind !== "files") throw new Error("Expected files");
    expect(parsed.files[0]?.path).toBe("src/index.ts");
    expect(buildWorkspaceReviewDiff([], "thread")).toEqual({ kind: "empty" });
  });
  it("retains every repository's complete patch when a member needs raw fallback", () => {
    const broken = "unrecognized patch format";
    const parsed = buildWorkspaceReviewDiff(
      [
        { path: "projects/valid", diff },
        { path: "projects/broken", diff: broken },
      ],
      "thread",
    );
    expect(parsed.kind).toBe("raw");
    if (parsed.kind !== "raw") throw new Error("Expected raw fallback");
    expect(parsed.text).toContain(`Repository: projects/valid\n${diff}`);
    expect(parsed.text).toContain(`Repository: projects/broken\n${broken}`);
    expect(parsed.reason).toContain("projects/broken:");
  });
});
