import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDisplayBranch } from "./thread-display-branch";

describe("resolveThreadDisplayBranch", () => {
  it("prefers the stored branch over the live checkout", () => {
    expect(
      resolveThreadDisplayBranch({
        branch: "feature/phone-thread",
        worktreePath: null,
        liveCheckoutBranch: "main",
      }),
    ).toBe("feature/phone-thread");
  });

  it("falls back to the live checkout for local threads with no stored branch", () => {
    expect(
      resolveThreadDisplayBranch({
        branch: null,
        worktreePath: null,
        liveCheckoutBranch: "main",
      }),
    ).toBe("main");
  });

  it("stays blank for local threads while the checkout is unknown", () => {
    expect(
      resolveThreadDisplayBranch({
        branch: null,
        worktreePath: null,
        liveCheckoutBranch: null,
      }),
    ).toBeNull();
  });

  it("never falls back for worktree threads", () => {
    expect(
      resolveThreadDisplayBranch({
        branch: null,
        worktreePath: "/repo/.t3/worktrees/feature",
        liveCheckoutBranch: "main",
      }),
    ).toBeNull();
  });

  it("treats blank strings as missing", () => {
    expect(
      resolveThreadDisplayBranch({ branch: "  ", worktreePath: null, liveCheckoutBranch: "main" }),
    ).toBe("main");
    expect(
      resolveThreadDisplayBranch({ branch: null, worktreePath: null, liveCheckoutBranch: "  " }),
    ).toBeNull();
  });
});
