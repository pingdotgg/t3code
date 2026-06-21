import { describe, expect, it } from "@effect/vitest";

import {
  hasActiveWorkspaceFolder,
  resolveActiveWorkspaceFolder,
  workspaceFolderIdentityKey,
  workspaceFoldersIncludeRoot,
} from "./workspaceFolders.ts";

describe("workspace folder helpers", () => {
  it("builds stable identity keys from VS Code URI parts", () => {
    expect(
      workspaceFolderIdentityKey({
        uriScheme: "vscode-remote",
        uriAuthority: "ssh-remote+host",
        fsPath: "/workspaces/repo",
      }),
    ).toBe("vscode-remote:ssh-remote+host:/workspaces/repo");

    expect(workspaceFolderIdentityKey({ fsPath: "/workspaces/repo" })).toBe(
      "file::/workspaces/repo",
    );
  });

  it("resolves active folders by key with first-folder fallback", () => {
    const first = { key: "file::/repo-a", cwd: "/repo-a" };
    const second = { key: "file::/repo-b", cwd: "/repo-b" };

    expect(resolveActiveWorkspaceFolder([first, second], second.key)).toBe(second);
    expect(resolveActiveWorkspaceFolder([first, second], "missing")).toBe(first);
    expect(resolveActiveWorkspaceFolder([first, second])).toBe(first);
    expect(resolveActiveWorkspaceFolder([])).toBeUndefined();
  });

  it("matches workspace roots and active folder metadata", () => {
    expect(workspaceFoldersIncludeRoot([{ cwd: "/repo" }], "/repo/.")).toBe(true);
    expect(workspaceFoldersIncludeRoot([{ cwd: "/repo" }], "/other")).toBe(false);
    expect(
      hasActiveWorkspaceFolder({
        workspaceFolders: [{ key: "file::/repo", cwd: "/repo" }],
        activeWorkspaceFolderKey: "file::/repo",
      }),
    ).toBe(true);
    expect(
      hasActiveWorkspaceFolder({
        workspaceFolders: [{ key: "file::/repo", cwd: "/repo" }],
        activeWorkspaceFolderKey: "file::/other",
      }),
    ).toBe(false);
  });
});
