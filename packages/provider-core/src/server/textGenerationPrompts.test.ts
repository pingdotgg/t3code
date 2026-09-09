import { buildCommitPlanPrompt } from "./textGenerationPrompts.ts";
import { describe, expect, it } from "vite-plus/test";

import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildCommitPlanPrompt", () => {
  it("requires an exact, ordered partition of change-unit IDs", () => {
    const result = buildCommitPlanPrompt({
      branch: "feature/split",
      changeUnitSummary: "H001\tsrc/a.ts\t@@ -1 +1 @@\nH002\tsrc/a.test.ts\twhole-file change",
      annotatedPatch: "### H001 — src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    });

    expect(result.prompt).toContain("use every ID from Available change units exactly once");
    expect(result.prompt).toContain(
      "order prerequisite commits before commits that depend on them",
    );
    expect(result.prompt).toContain("H002\tsrc/a.test.ts");
    expect(result.prompt).toContain("Branch: feature/split");
  });
});

