import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linearDraftWorkspaceSelection, linearSettingsOf } from "./linearLaunchHelpers";

describe("linear launch helpers", () => {
  it("starts a worktree on the mapped base branch and a local checkout on the current one", () => {
    expect(
      linearDraftWorkspaceSelection({ envMode: "worktree", branch: "main", worktreePath: null }),
    ).toEqual({ mode: "worktree", branch: "main", worktreePath: null });
    expect(
      linearDraftWorkspaceSelection({ envMode: "local", branch: null, worktreePath: null }),
    ).toEqual({ mode: "local", branch: null, worktreePath: null, followsCurrentCheckout: true });
  });

  it("falls back to default Linear settings before the server config loads", () => {
    expect(linearSettingsOf(undefined)).toBe(DEFAULT_SERVER_SETTINGS.linear);
  });
});
