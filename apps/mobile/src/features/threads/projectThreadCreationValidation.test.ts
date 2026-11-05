import { describe, expect, it } from "vite-plus/test";

import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("keeps a chosen branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        selectedBranch: "release",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("release");
  });
});
