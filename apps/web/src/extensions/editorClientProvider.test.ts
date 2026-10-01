import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ClientProviderCaller } from "@t3tools/contracts";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { createEditorClientProvider, type EditorLauncher } from "./clientProviders";
import type { ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";

const shells = vi.hoisted(
  () => new Map<string, { projectId: string; worktreePath: string | null }>(),
);
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: (ref: { threadId: string }) => shells.get(ref.threadId) ?? null,
  readProject: (ref: { projectId: string }) =>
    ref.projectId === "project-a" ? { workspaceRoot: "/project/root" } : null,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));

const caller: ClientProviderCaller = {
  installationId: "ext.files",
  contentHash: "hash",
  installationGeneration: 1,
};
const context: ViewContext = {
  client: "web",
  resource: {
    namespace: "ext.files",
    id: "ext.files/view",
    environmentId: "env",
    projectId: "project-a",
    threadId: "thread-a",
  },
};
const installation = {
  id: "ext.files",
  contentHash: "hash",
  installationGeneration: 1,
  enabled: true,
  grants: { capabilities: ["t3.ui/editor.open"], projectIds: [ProjectId.make("project-a")] },
  package: {
    manifest: {
      surfaces: [
        {
          id: "ext.files/view",
          scope: "project",
          clients: ["web"],
          placements: ["side-panel"],
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
  },
} as unknown as InstalledPackage;

function provider(overrides: Partial<EditorLauncher> = {}) {
  const openInEditor = vi.fn(async () => AsyncResult.success(undefined));
  const launcher: EditorLauncher = {
    availableEditors: () => ["vscode"],
    remoteState: () => ({ mode: "local-exec" }),
    remoteEditors: async () => ["vscode"],
    openRemoteUrl: vi.fn(async () => true),
    openInEditor,
    ...overrides,
  };
  return {
    openInEditor,
    launcher,
    editor: createEditorClientProvider(
      {
        environmentId: EnvironmentId.make("env"),
        client: "web",
        emit: vi.fn(),
        installations: () => [installation],
      },
      launcher,
    ),
  };
}

function workspaceOpen(overrides: Partial<ViewContext["resource"]> = {}): ClientProviderInvokeCall {
  return {
    method: "openPath",
    input: { path: "src/my file.ts:4", workspace: true },
    context: { ...context, resource: { ...context.resource, ...overrides } },
    caller,
    signal: new AbortController().signal,
  };
}

describe("workspace editor path", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal("CustomEvent", vi.fn());
    shells.clear();
    shells.set("thread-a", { projectId: "project-a", worktreePath: "/thread/checkout" });
  });

  it.each(["remote-links", "remote-unavailable"] as const)(
    "keeps explicit-cwd calls native in %s mode",
    async (mode) => {
      const { editor, openInEditor, launcher } = provider({
        remoteState: () =>
          mode === "remote-links" ? { mode, host: { kind: "ssh-alias", host: "dev" } } : { mode },
      });
      await expect(
        editor.invoke({ ...workspaceOpen(), input: { path: "src/a.ts:3:5", cwd: "/explicit" } }),
      ).resolves.toMatchObject({ status: "opened", path: "/explicit/src/a.ts:3:5" });
      expect(openInEditor).toHaveBeenCalledWith({
        environmentId: "env",
        input: { cwd: "/explicit/src/a.ts:3:5", editor: "vscode" },
      });
      expect(launcher.openRemoteUrl).not.toHaveBeenCalled();
    },
  );

  it("removes positions from remote URLs and never consumes an unseen SSH hint", async () => {
    const { editor, launcher } = provider({
      remoteState: () => ({ mode: "remote-links", host: { kind: "ssh-alias", host: "dev" } }),
    });
    await expect(
      editor.invoke({ ...workspaceOpen(), input: { path: "src/my file.ts:4:2", workspace: true } }),
    ).resolves.toEqual({
      status: "opened",
      path: "/thread/checkout/src/my file.ts:4:2",
      editor: "vscode",
      url: "vscode://vscode-remote/ssh-remote+dev/thread/checkout/src/my%20file.ts",
    });
    expect(launcher.openRemoteUrl).toHaveBeenCalledWith(
      "vscode://vscode-remote/ssh-remote+dev/thread/checkout/src/my%20file.ts",
    );
    expect(getLocalStorageItem("t3code:remote-open-hint-seen", Schema.Boolean)).toBeNull();
  });

  it.each([
    { primary: true, mode: "local-exec", visible: true },
    { primary: false, mode: "local-exec", visible: false },
    { primary: false, mode: "remote-links", visible: true },
    { primary: false, mode: "remote-unavailable", visible: true },
  ] as const)(
    "reports native picker visibility for $primary / $mode",
    async ({ primary, mode, visible }) => {
      const { editor } = provider({
        isPrimaryEnvironment: () => primary,
        remoteState: () =>
          mode === "remote-links" ? { mode, host: { kind: "ssh-alias", host: "dev" } } : { mode },
      });
      await expect(
        editor.invoke({ ...workspaceOpen(), method: "getCapabilities", input: {} }),
      ).resolves.toMatchObject({ editor: { visible } });
    },
  );

  it("offers native editor choices and opens a warmed remote choice before yielding", async () => {
    let activated = false;
    const openRemoteUrl = vi.fn(async () => {
      activated = true;
      return true;
    });
    const { editor } = provider({
      remoteState: () => ({ mode: "remote-links", host: { kind: "ssh-alias", host: "dev" } }),
      remoteEditors: async () => ["vscode", "cursor"],
      openRemoteUrl,
      environmentLabel: () => "Remote Mac",
    });
    await expect(
      editor.invoke({ ...workspaceOpen(), method: "getCapabilities", input: {} }),
    ).resolves.toMatchObject({
      editor: {
        editors: [
          { id: "cursor", label: "Cursor" },
          { id: "vscode", label: "VS Code" },
        ],
        preferredEditor: "cursor",
        remoteHint: "Opens over SSH. Needs your key on Remote Mac.",
      },
    });
    const opened = editor.invoke({
      ...workspaceOpen(),
      input: { path: "src/a.ts:2:3", workspace: true, editor: "vscode", hintShown: true },
    });
    expect(activated).toBe(true);
    await expect(opened).resolves.toMatchObject({ status: "opened", editor: "vscode" });
    expect(getLocalStorageItem("t3code:remote-open-hint-seen", Schema.Boolean)).toBe(true);
  });

  it("rejects a workspace request that also supplies cwd", async () => {
    await expect(
      provider().editor.invoke({
        ...workspaceOpen(),
        input: { path: "a.ts", cwd: "/ignored", workspace: true },
      }),
    ).rejects.toMatchObject({ code: "provider-rejected" });
  });

  it.each([false, new Error("shell refused")])(
    "keeps preferences and a displayed hint after a refused remote launch (%s)",
    async (outcome) => {
      const { editor } = provider({
        remoteState: () => ({ mode: "remote-links", host: { kind: "ssh-alias", host: "dev" } }),
        openRemoteUrl: async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      });
      await expect(
        editor.invoke({
          ...workspaceOpen(),
          input: { path: "a.ts", workspace: true, hintShown: true },
        }),
      ).resolves.toMatchObject({ status: "refused", reason: "open-failed" });
      expect(getLocalStorageItem("t3code:remote-open-hint-seen", Schema.Boolean)).toBeNull();
    },
  );

  it("rejects an unavailable editor without executing or navigating", async () => {
    const { editor, launcher, openInEditor } = provider();
    await expect(
      editor.invoke({
        ...workspaceOpen(),
        input: { path: "a.ts", workspace: true, editor: "invented" },
      }),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(launcher.openRemoteUrl).not.toHaveBeenCalled();
  });

  it("uses the selected thread's checkout before the project root", async () => {
    const { editor, openInEditor } = provider();
    await expect(editor.invoke(workspaceOpen())).resolves.toEqual({
      status: "opened",
      path: "/thread/checkout/src/my file.ts:4",
      editor: "vscode",
    });
    expect(openInEditor).toHaveBeenCalledWith({
      environmentId: "env",
      input: { cwd: "/thread/checkout/src/my file.ts:4", editor: "vscode" },
    });
  });

  it("falls back to the project root for a project-scoped surface without a thread", async () => {
    const call = workspaceOpen();
    const { threadId: _threadId, ...resource } = call.context.resource;
    await expect(
      provider().editor.invoke({ ...call, context: { ...context, resource } }),
    ).resolves.toMatchObject({ status: "opened", path: "/project/root/src/my file.ts:4" });
  });

  it.each([{ threadId: "gone" }, { projectId: "project-other" }, { threadId: "other" }])(
    "refuses a missing or cross-project checkout (%s)",
    async (resource) => {
      shells.set("other", { projectId: "project-other", worktreePath: "/other" });
      const { editor, openInEditor } = provider();
      await expect(editor.invoke(workspaceOpen(resource))).rejects.toMatchObject({
        code: "client-target-denied",
      });
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
});
