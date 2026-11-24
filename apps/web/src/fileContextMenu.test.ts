import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useFileContextMenu } from "./fileContextMenu";
import type { RemoteOpenResolution } from "./remoteOpen";

const state = vi.hoisted(() => ({
  remoteOpen: { state: { mode: "local-exec" }, isResolved: true } as RemoteOpenResolution,
  openInEditor: vi.fn(async () => ({ _tag: "Success" })),
  openRemoteEditorUrl: vi.fn(async (_url: string) => true),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    availableEditors: ["cursor", "file-manager"],
    shellRevealInFileManager: true,
    shellRevealInFileManagerKind: "xdg-open",
    environment: { platform: { os: "linux" } },
  }),
}));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useMessages: () => (text: string) => text,
}));
vi.mock(import("./state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock("./editorMenuIcons", () => ({ useEditorMenuIcons: () => new Map() }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.openInEditor }));
vi.mock(import("./remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => state.remoteOpen,
  useRemoteCapableEditors: () => ["vscode"],
  openRemoteEditorUrl: state.openRemoteEditorUrl,
}));

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

describe("useFileContextMenu", () => {
  it.each<[string, RemoteOpenResolution]>([
    ["remote-unavailable", { state: { mode: "remote-unavailable" }, isResolved: true }],
    ["unresolved", { state: { mode: "local-exec" }, isResolved: false }],
  ])("offers no open actions when remote open is %s", async (_mode, resolution) => {
    state.remoteOpen = resolution;
    state.openInEditor.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    expect(menu.buildItems(BASE_TARGET).filter((item) => !item.id.startsWith("copy-"))).toEqual([]);
    await menu.activate("open", BASE_TARGET);
    await menu.activate("editor:vscode", BASE_TARGET);
    expect(state.openInEditor).not.toHaveBeenCalled();
  });

  it("opens files over SSH remote links instead of on the server host", async () => {
    state.remoteOpen = {
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "box", username: "me" } },
      isResolved: true,
    };
    state.openInEditor.mockClear();
    state.openRemoteEditorUrl.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    expect(menu.buildItems(BASE_TARGET).filter((item) => !item.id.startsWith("copy-"))).toEqual([
      {
        id: "open-with",
        label: "Open with",
        children: [{ id: "editor:vscode", label: "VS Code" }],
      },
    ]);
    await menu.activate("open", BASE_TARGET);
    await menu.activate("editor:vscode", BASE_TARGET);
    await menu.activate("editor:vscode", { ...BASE_TARGET, filePath: "src", isDirectory: true });
    expect(state.openInEditor).not.toHaveBeenCalled();
    expect(state.openRemoteEditorUrl.mock.calls).toEqual([
      ["vscode://vscode-remote/ssh-remote+me%40box/workspace/project/src/index.ts:1:1"],
      ["vscode://vscode-remote/ssh-remote+me%40box/workspace/project/src?windowId=_blank"],
    ]);
  });

  it("opens files on the server host when remote open is local-exec", async () => {
    state.remoteOpen = { state: { mode: "local-exec" }, isResolved: true };
    state.openInEditor.mockClear();
    const menu = useFileContextMenu(BASE_TARGET.environmentId);

    expect(
      menu
        .buildItems(BASE_TARGET)
        .filter((item) => !item.id.startsWith("copy-"))
        .map((item) => item.id),
    ).toEqual(["open", "reveal-in-folder", "open-with"]);
    await menu.activate("open", BASE_TARGET);
    expect(state.openInEditor).toHaveBeenCalledWith({
      environmentId: BASE_TARGET.environmentId,
      input: { cwd: "/workspace/project/src/index.ts", editor: "file-manager" },
    });
  });
});
