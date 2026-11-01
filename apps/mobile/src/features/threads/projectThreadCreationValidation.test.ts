import { describe, expect, it } from "vite-plus/test";

import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched local draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("never borrows the current checkout for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBeNull();
  });
});
