import { describe, expect, it, vi } from "vite-plus/test";

import { resolveProjectMainCheckout } from "./useHandleNewThread.logic";

describe("resolveProjectMainCheckout", () => {
  it("uses loaded active-project refs without issuing another lookup", async () => {
    const loadRefs = vi.fn(async () => null);

    await expect(
      resolveProjectMainCheckout({
        isActiveProject: true,
        activeRefsLoaded: true,
        activeProjectMainCheckout: { branch: "main", path: "/repo" },
        projectWorkspaceRoot: "/repo/worktree",
        loadRefs,
      }),
    ).resolves.toEqual({ branch: "main", path: "/repo" });
    expect(loadRefs).not.toHaveBeenCalled();
  });

  it("waits for ref discovery when active-project refs are still loading", async () => {
    const loadRefs = vi.fn(async () => ({
      refs: [
        {
          name: "feature/current",
          current: true,
          isDefault: false,
          worktreePath: "/repo",
        },
      ],
      mainCheckoutPath: "/repo",
    }));

    await expect(
      resolveProjectMainCheckout({
        isActiveProject: true,
        activeRefsLoaded: false,
        activeProjectMainCheckout: undefined,
        projectWorkspaceRoot: "/repo",
        loadRefs,
      }),
    ).resolves.toEqual({ branch: "feature/current", path: null });
    expect(loadRefs).toHaveBeenCalledOnce();
  });

  it("does not reuse another project's checkout when ref discovery fails", async () => {
    await expect(
      resolveProjectMainCheckout({
        isActiveProject: false,
        activeRefsLoaded: true,
        activeProjectMainCheckout: { branch: "feature/active", path: "/active" },
        projectWorkspaceRoot: "/target",
        loadRefs: async () => null,
      }),
    ).resolves.toBeUndefined();
  });
});
