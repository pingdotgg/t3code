import { EnvironmentId, ThreadId, type EditorId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { RemoteOpenState } from "~/remoteOpen";

const state = vi.hoisted(() => ({
  file: {} as Record<string, unknown>,
  openUrl: vi.fn(),
}));

// The real OpenInPicker and buildRemoteOpenUrl run; the rest of the panel is stubbed.
vi.mock("./projectFilesQueryState", () => ({
  useProjectFileQuery: () => state.file,
  getOptimisticProjectFileQueryData: vi.fn(),
  getProjectFileContents: vi.fn(),
  setProjectFileQueryData: vi.fn(),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenState: (): RemoteOpenState => ({
    mode: "remote-links",
    host: { kind: "ssh-alias", host: "test-host" },
  }),
  useRemoteCapableEditors: (): readonly EditorId[] => ["vscode"],
  useRemoteOpenHint: () => [true, vi.fn()],
  openRemoteEditorUrl: state.openUrl,
}));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "Test host" }),
  useEnvironmentHttpBaseUrl: () => null,
  usePrimaryEnvironmentId: () => "primary",
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: "createUrl" } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: "open" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/browser/previewRuntime", () => ({ usePreviewAvailable: () => false }));
vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: () => false,
  openFileInPreview: vi.fn(),
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrlRefresh: vi.fn(), useAssetUrlState: vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => false,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  setLocalStorageItem: vi.fn(),
  useLocalStorage: (_key: string, initial: boolean) => [initial, vi.fn()],
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
vi.mock("~/composerDraftStore", () => ({ useComposerDraftStore: vi.fn() }));
vi.mock("~/keybindings", () => ({
  isOpenFavoriteEditorShortcut: () => false,
  shortcutLabelForCommand: () => null,
}));
vi.mock("~/components/ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: {} }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/group", () => ({ Group: "div", GroupSeparator: "span" }));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  MenuPopup: () => null,
  MenuItem: "button",
  MenuItemLabel: "span",
  MenuShortcut: "span",
}));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("~/components/media/MediaVideoPlayer", () => ({ MediaVideoPlayer: () => null }));
vi.mock("~/components/media/MediaActions", () => ({ MediaActions: () => null }));
vi.mock("../DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: () => null }));
vi.mock("../diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));
vi.mock("./AttachmentFilePreview", () => ({ AttachmentFilePreview: () => null }));
vi.mock("./AudioPreview", () => ({ AudioPreview: () => null }));
vi.mock("./BrowserDocumentFrame", () => ({
  BrowserDocumentFrame: () => null,
  isPdfPreviewFile: () => false,
}));
vi.mock("./DelimitedTablePreview", () => ({ DelimitedTablePreview: () => null }));
vi.mock("./FileBrowserPanel", () => ({ default: () => null }));
vi.mock("./FileBreadcrumbs", () => ({ FileBreadcrumbs: () => null }));
vi.mock("./FileMarkdownPreview", () => ({ FileMarkdownPreview: () => null }));
vi.mock("./ReadOnlySourcePreview", () => ({ default: () => null }));
vi.mock("./useFileSaveCoordinator", () => ({ useFileSaveCoordinator: vi.fn() }));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_LINK_REVEAL_ATTRIBUTE: "data-file-link-reveal",
  FILE_LINK_REVEAL_UNSAFE_CSS: "",
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: () => null,
  FileSurfaceFailure: () => null,
  FileSurfaceLoading: () => null,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("remote");
const readFileResult = { relativePath: "src", contents: "", byteLength: 0, truncated: false };
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.openUrl.mockReset().mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function openFromPreview(relativePath: string, file: Record<string, unknown>) {
  state.file = {
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
    readError: null,
    isNotFile: false,
    isFile: false,
    ...file,
  };
  await act(async () => {
    renderer = create(
      <FilePreviewPanel
        environmentId={environmentId}
        cwd="/work/project"
        projectName="project"
        relativePath={relativePath}
        threadRef={{ environmentId, threadId: ThreadId.make("thread") }}
        composerDraftTarget={{ environmentId, threadId: ThreadId.make("thread") }}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={["vscode"]}
        revealLine={null}
        revealRequestId={0}
        onOpenFile={vi.fn()}
        onNavigateFolder={vi.fn()}
        folderTrail={undefined}
        onPendingChange={vi.fn()}
        selectedFilePending={false}
        workspaceMutationId={null}
      />,
    );
  });
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Open file in preferred editor" }).props.onClick(),
  );
}

it("opens a previewed file at a position so VS Code does not treat it as a folder", async () => {
  await openFromPreview("src/app.ts", { data: readFileResult, isFile: true });
  expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
    "vscode://vscode-remote/ssh-remote+test-host/work/project/src/app.ts:1:1",
  );
});

it("opens a folder reached through the preview as a plain folder link", async () => {
  await openFromPreview("src", { isNotFile: true });
  expect(state.openUrl).toHaveBeenCalledExactlyOnceWith(
    "vscode://vscode-remote/ssh-remote+test-host/work/project/src",
  );
});
