import { describe, expect, it } from "vite-plus/test";

import { workspaceMutationRefreshToken } from "./useWorkspaceMutationRefresh";

describe("workspace mutation refresh", () => {
  it("scopes the same mutation to each preview resource", () => {
    expect(workspaceMutationRefreshToken("file:/repo/README.md", "event-1")).not.toBe(
      workspaceMutationRefreshToken("diff:/repo", "event-1"),
    );
    expect(workspaceMutationRefreshToken("file:/repo/README.md", null)).toBeNull();
  });
});
