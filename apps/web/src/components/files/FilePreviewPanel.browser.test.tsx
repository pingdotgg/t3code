import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
  assetUrl: { _tag: "Loading" } as import("~/assets/assetUrls").AssetUrlState,
  mintUrl: vi.fn<() => Promise<string | null>>(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => state.mintUrl,
  useAssetUrlState: () => state.assetUrl,
}));
// The Word engine compiles a large WebAssembly bundle; these tests only need the URL it loads.
vi.mock(import("./OfficeFilePreview"), () => ({
  OfficeFilePreview: ({ src }: { src: string }) => <div data-testid="office-preview">{src}</div>,
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.optimistic = null;
  state.assetUrl = { _tag: "Loading" };
  let mints = 0;
  state.mintUrl.mockReset().mockImplementation(async () => `/assets/report.docx?mint=${++mints}`);
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function filePreview(relativePath: string, workspaceMutationId: string | null) {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={workspaceMutationId}
    />
  );
}

function markdownPreview(truncated: boolean) {
  state.file = {
    relativePath: "tasks.md",
    contents: "- [ ] Keep the rest of this file\n",
    byteLength: truncated ? 1_200_000 : 32,
    truncated,
  };
  return filePreview("tasks.md", null);
}

function documentPreview(workspaceMutationId: string, fileRevision: string) {
  state.file = null;
  state.assetUrl = {
    _tag: "Success",
    url: "/assets/report.docx",
    expiresAt: Number.MAX_SAFE_INTEGER,
    fileRevision,
  };
  return filePreview("report.docx", workspaceMutationId);
}

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
      },
    });
  });
});

describe("workspace document previews", () => {
  it("keeps an unchanged document loaded when another workspace change lands", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    await screen.rerender(documentPreview("mutation-2", "revision-1"));

    expect(state.mintUrl, "an unchanged document re-minted its URL").toHaveBeenCalledOnce();
    expect(screen.container.contains(loaded), "an unchanged document was remounted").toBe(true);
  });

  it("loads the new bytes when the document itself changes", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");

    await screen.rerender(documentPreview("mutation-2", "revision-2"));

    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=2");
  });
});
