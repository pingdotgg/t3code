import { describe, expect, it } from "vite-plus/test";

import { resolveChatHeaderActionVisibility } from "./ChatHeaderActionsMenu";

describe("resolveChatHeaderActionVisibility", () => {
  it("keeps server-backed workspace actions while omitting Open In remotely", () => {
    expect(
      resolveChatHeaderActionVisibility({
        routeKind: "server",
        hasProjectActions: true,
        hasOpenInCwd: true,
        showOpenIn: false,
        hasGitCwd: true,
        hasWorkspaceRoot: true,
      }),
    ).toEqual({
      hasOpenInActions: false,
      hasWorkspaceActions: true,
      showDurableThreadActions: true,
      showWorkspacePath: true,
    });
  });

  it("keeps drafts workspace-only", () => {
    expect(
      resolveChatHeaderActionVisibility({
        routeKind: "draft",
        hasProjectActions: true,
        hasOpenInCwd: true,
        showOpenIn: true,
        hasGitCwd: true,
        hasWorkspaceRoot: true,
      }),
    ).toEqual({
      hasOpenInActions: true,
      hasWorkspaceActions: true,
      showDurableThreadActions: false,
      showWorkspacePath: true,
    });
  });

  it("does not render empty action groups", () => {
    expect(
      resolveChatHeaderActionVisibility({
        routeKind: "draft",
        hasProjectActions: false,
        hasOpenInCwd: false,
        showOpenIn: false,
        hasGitCwd: false,
        hasWorkspaceRoot: false,
      }),
    ).toEqual({
      hasOpenInActions: false,
      hasWorkspaceActions: false,
      showDurableThreadActions: false,
      showWorkspacePath: false,
    });
  });
});
