/**
 * The first-party Files pack as the selected `t3.file/presentation` provider,
 * driven through the real panel store, navigation provider, NativeRightPanel
 * and SelectedApiPresentation — the path a host file link and the pack's own
 * "Open in panel" take. File I/O is simulated; nothing touches a disk.
 */
// Checks whether a sibling pack's source is present in this checkout, outside Effect services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { persistPreferredEditor } from "../editorPreferences";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EditorId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { filePresentationApi, uiNavigationApi } from "@t3tools/extension-sdk/catalogue";
import type { ApiInvocation, ApiStreamInvocation } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ClientCodeView, CodeViewEditorProps } from "@t3tools/extension-sdk/environment";
import type { ClientUiKit, UiButtonProps, UiTreeRowProps } from "@t3tools/extension-sdk/ui";
import type { ViewSession } from "@t3tools/extension-sdk/host";

import { selectSelectedRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import {
  CLIENT_PROVIDER_DESCRIPTORS,
  createEditorClientProvider,
  createNavigationClientProvider,
  type EditorLauncher,
} from "./clientProviders";
import { editorClientSeam } from "./editorClientSeam.testSupport";
import type { InstalledPackage } from "./installedController";
import { uiEditorApi, type UiEditorCapabilities } from "@t3tools/extension-sdk/catalogue";
import { registerInstalledApiClient, setInstalledApiPolicy } from "./installedApiClients";
import { installedWorkspaceContext } from "./installedContext";
import { NativeRightPanel } from "./nativePanels";
import { registerWorkspaceExtension } from "./workspaceRegistry";

// Only the server's environment tag is needed; its implementation owns unrelated services.
vi.mock("../../../server/src/environment/ServerEnvironment", async () => {
  const { Service } = await import("effect/Context");
  class ServerEnvironment extends Service<ServerEnvironment, unknown>()(
    "t3/environment/ServerEnvironment",
  ) {}
  return { ServerEnvironment };
});

vi.mock("./terminal/PersistentThreadTerminal", () => ({
  PersistentThreadTerminalDrawer: () => null,
  PersistentThreadTerminalPanel: () => null,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
vi.mock("../components/AgentsPanel", () => ({ AgentsPanel: () => null }));
vi.mock("../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("../components/pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => null,
}));
vi.mock("../components/pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => null,
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => null,
  readThreadShell: () => ({ projectId: "p", worktreePath: null }),
  readProject: () => ({ workspaceRoot: "/fixture" }),
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Frame = { readonly type: string; readonly value: unknown };
type PackHost = {
  readonly React: typeof React;
  readonly uiKit?: ClientUiKit;
  readonly codeView: ClientCodeView;
  invokeApi(request: ApiInvocation, signal: AbortSignal): Promise<unknown>;
  subscribeApi(request: ApiStreamInvocation, signal: AbortSignal): AsyncIterable<Frame>;
  discoverApis(): Promise<readonly unknown[]>;
  invokeTool(): Promise<never>;
};
type PackView = { readonly renderer: React.ComponentType };
type Pack = {
  readonly package: unknown;
  client(host: PackHost): {
    readonly surfaces: readonly { createView(session: ViewSession): PackView }[];
  };
};

// The packs are not web dependencies, so this project cannot type-check their
// source; they load by path and are typed by the shape used here.
const files = (
  (await import("../../../../packages/first-party-extensions/files/extension.tsx" as string)) as {
    default: Pack;
  }
).default;
// The Diff pack ships in its own stack layer; its case runs where it is present.
const DIFF_SOURCE = new URL(
  "../../../../packages/first-party-extensions/diff/extension.tsx",
  import.meta.url,
);
const diff = NodeFS.existsSync(DIFF_SOURCE)
  ? (
      (await import(/* @vite-ignore */ DIFF_SOURCE.href)) as {
        default: Pack;
      }
    ).default
  : null;
const filesServer = (
  (await import("../../../../packages/first-party-extensions/files/server.ts" as string)) as {
    default: {
      apis: readonly {
        methods: readonly {
          invoke(input: unknown, session: { signal: AbortSignal }): unknown;
        }[];
      }[];
    };
  }
).default;

const pending = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** The tree's scrolling element, `height` tall; a fresh one each time it mounts. */
class FakeViewport {
  scrollTop = 0;
  constructor(readonly clientHeight: number) {}
}

function KitButton({ variant, size: _size, ...props }: UiButtonProps) {
  return <button data-kit-variant={variant} {...props} />;
}
function KitTreeRow({
  path,
  depth,
  directory,
  expanded,
  selected,
  label,
  ...props
}: UiTreeRowProps) {
  return (
    <button
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={directory ? expanded : undefined}
      aria-selected={selected}
      {...props}
    >
      {label ?? path.split("/").at(-1)}
    </button>
  );
}
const nullControl = () => null;
const alternateKit: ClientUiKit = {
  version: 1,
  Button: KitButton,
  TreeRow: KitTreeRow,
  Input: ({ controlSize: _controlSize, ...props }) => <input {...props} />,
  InputGroup: ({ controlSize: _controlSize, variant: _variant, ...props }) => <div {...props} />,
  InputGroupAddon: nullControl,
  Toolbar: ({ variant: _variant, ...props }) => <div {...props} />,
  Menu: ({ open, onOpenChange, children }) => (
    <div data-editor-menu-open={open}>
      <button type="button" aria-label="Choose editor" onClick={() => onOpenChange(!open)}>
        Choose editor
      </button>
      {open && children}
    </div>
  ),
  MenuTrigger: () => null,
  MenuPopup: ({ children }) => <div>{children}</div>,
  MenuSub: nullControl,
  MenuSubTrigger: nullControl,
  MenuSubPopup: nullControl,
  MenuGroup: nullControl,
  MenuRow: nullControl,
  MenuNote: ({ children }) => <p>{children}</p>,
  MenuItem: ({ children, disabled, closeOnClick: _closeOnClick, ...props }) => (
    <div role="menuitem" aria-disabled={disabled} {...props}>
      {children}
    </div>
  ),
  MenuSeparator: nullControl,
  MenuGroupLabel: nullControl,
  MenuRadioGroup: nullControl,
  MenuRadioItem: nullControl,
  Icon: nullControl,
};

interface Disk {
  readonly files: Record<string, string>;
  readonly uiKit?: ClientUiKit;
  readonly externalEditor?: boolean;
  readonly editorInvoke?: (request: ApiInvocation, signal: AbortSignal) => Promise<unknown>;
  /** Directory entries the tree snapshot lists next to the files. */
  readonly directories?: readonly string[];
  /** The selected presentation provider's version; the pack's own by default. */
  readonly presentationVersion?: string;
  /** Rejects the presentation provider's `open` while it returns an error. */
  readonly presentationError?: () => Error | undefined;
  /** The save outcome for the nth save (1-based). */
  readonly save?: (count: number) => unknown;
  /** Preference frames; a promise holds the stream until it settles. */
  readonly preferences?: Promise<Frame | Error>;
  /** The unary preference read; follows the stream unless given. */
  readonly preferencesRead?: Promise<Frame | Error>;
  /** A later preference change the stream carries after its first frame. */
  readonly preferenceChange?: Promise<Frame>;
  /** The preference write's receipt; unavailable unless given. */
  readonly preferenceWrite?: Promise<unknown>;
  /** The host's preview-browser open; records its calls and says how it went. */
  readonly previewFile?: (...args: unknown[]) => Promise<string>;
  /** Whether this client has a preview browser; it does unless given. */
  readonly previewSupported?: boolean;
  /** The host's `t3.ui/navigation` version; the SDK's own unless given. */
  readonly navigationVersion?: string;
  /** Gives the tree a scrolling element this tall; it has none unless given. */
  readonly viewportHeight?: number;
}

type Calls = {
  reads: number;
  saves: number;
  log: string[][];
  presentations: ApiInvocation[];
  preferenceWrites: unknown[];
  notifications: unknown[];
};
const newCalls = (): Calls => ({
  reads: 0,
  saves: 0,
  log: [],
  presentations: [],
  preferenceWrites: [],
  notifications: [],
});

const preferenceFrame = (disk: Disk) =>
  disk.preferences ??
  Promise.resolve<Frame>({
    type: "snapshot",
    value: { wordWrap: false, renderBrowserFile: true },
  });

function PackEditor(props: CodeViewEditorProps & { "aria-label": string }) {
  return <div>{props.contents}</div>;
}

function packHost(disk: Disk, calls: Calls) {
  const navigationVersion = disk.navigationVersion ?? uiNavigationApi.definition.version;
  const host: PackHost = {
    React,
    ...(disk.uiKit ? { uiKit: disk.uiKit } : {}),
    codeView: {
      version: 1,
      File: () => null,
      Diff: () => null,
      Editor: (props: CodeViewEditorProps) => <PackEditor aria-label="File editor" {...props} />,
    },
    async discoverApis() {
      return [
        {
          id: "t3.file/presentation",
          providerId: "t3.files",
          pluginId: "t3.files",
          version: disk.presentationVersion ?? filePresentationApi.definition.version,
          generation: 1,
          health: "ready",
          selected: true,
        },
        {
          id: "t3.ui/navigation",
          providerId: "host.ui.navigation",
          version: navigationVersion,
          generation: 1,
          health: "ready",
          selected: true,
        },
      ];
    },
    async invokeApi(request, signal) {
      calls.log.push([request.id, request.method]);
      if (request.id === "t3.file/presentation") calls.presentations.push(request);
      const presentationError =
        request.id === "t3.file/presentation" ? disk.presentationError?.() : undefined;
      if (presentationError) throw presentationError;
      if (request.id === "t3.file/presentation")
        return filesServer.apis[0]!.methods[0]!.invoke(request.input, { signal });
      if (request.id === "t3.ui/navigation") return navigation.invoke(request, signal);
      if (disk.editorInvoke && request.id === "t3.ui/editor")
        return disk.editorInvoke(request, signal);
      if (disk.externalEditor && request.id === "t3.ui/editor")
        return request.method === "getCapabilities"
          ? {
              adapter: "host.ui.editor",
              operations: { openPath: true },
              clients: [],
              editor: {
                visible: true,
                preferredEditor: "vscode",
                remoteHint: "Remote workspace",
                editors: [
                  { id: "vscode", label: "VS Code" },
                  { id: "cursor", label: "Cursor" },
                ],
              },
            }
          : {
              status: "opened",
              path: "/fixture/a.txt",
              editor: "cursor",
              url: "cursor://file/fixture/a.txt",
            };
      if (request.id === "t3.ui/notifications" && request.method === "notify") {
        calls.notifications.push(request.input);
        return { id: "toast" };
      }
      if (request.id === "t3.ui/preferences" && request.method === "setPreferences") {
        calls.preferenceWrites.push(request.input);
        if (disk.preferenceWrite) return disk.preferenceWrite;
      }
      if (request.id === "t3.ui/preferences" && request.method === "getPreferences") {
        const frame = await (disk.preferencesRead ?? preferenceFrame(disk));
        if (frame instanceof Error) throw frame;
        return frame.value;
      }
      if (request.id === "t3.resources/lease") {
        if (request.method === "getCapabilities") return { supportedKinds: ["workspace-file"] };
        return { url: "https://example.invalid/page.html", expiresAt: Date.now() + 3_600_000 };
      }
      const relativePath = (request.input as { relativePath?: string }).relativePath ?? "";
      if (request.method === "readSnapshot") {
        calls.reads++;
        return { kind: "editable", contents: disk.files[relativePath], revision: "r1" };
      }
      if (request.method === "save") {
        calls.saves++;
        return disk.save?.(calls.saves) ?? { kind: "saved", revision: `r${calls.saves + 1}` };
      }
      throw new Error("unavailable: " + request.id + " " + request.method);
    },
    subscribeApi(request, signal) {
      return (async function* () {
        if (request.id === "t3.ui/preferences") {
          const frame = await preferenceFrame(disk);
          if (frame instanceof Error) throw frame;
          yield frame;
          if (disk.preferenceChange) yield await disk.preferenceChange;
          await pending(signal);
        } else if (request.id === "t3.workspace/tree") {
          const entries = [
            ...(disk.directories ?? []).map((path) => ({ path, kind: "directory" })),
            ...Object.keys(disk.files).map((path) => ({ path, kind: "file" })),
          ];
          // The contract's chunks carry at most 200 entries.
          for (let start = 0; start < entries.length; start += 200)
            yield {
              type: "data",
              value: {
                kind: "chunk",
                entries: entries.slice(start, start + 200),
                truncated: false,
              },
            };
          yield {
            type: "data",
            value: { kind: "complete", entryCount: entries.length, truncated: false },
          };
        } else await pending(signal);
      })();
    },
    invokeTool: async () => {
      throw new Error("unused");
    },
  };
  let navigation = {
    invoke: (_request: ApiInvocation, _signal: AbortSignal): Promise<unknown> =>
      Promise.reject(new Error("navigation unavailable")),
  };
  return {
    host,
    useNavigation(invoke: typeof navigation.invoke) {
      navigation = { invoke };
    },
  };
}

const context: ViewContext = {
  client: "web",
  resource: {
    namespace: "t3.workspace",
    id: "file",
    environmentId: "files-flow",
    projectId: "p",
    threadId: "t",
  },
};
const ref = scopeThreadRef(EnvironmentId.make("files-flow"), ThreadId.make("t"));
/** ChatView's right panel context for the mocked thread and project. */
const panelContext = installedWorkspaceContext({
  environmentId: "files-flow",
  projectId: "p",
  threadId: "t",
  projectWorkspaceRoot: "/fixture",
  threadWorktreePath: null,
  client: "web",
});

/** Mounts the right panel with Files selected for `t3.file/presentation`. */
async function mountPanel(disk: Disk) {
  const calls = newCalls();
  const { host, useNavigation } = packHost(disk, calls);
  const caller = { installationId: "t3.files", contentHash: "h", installationGeneration: 1 };
  const installed = {
    id: "t3.files",
    contentHash: "h",
    installationGeneration: 1,
    enabled: true,
    package: files.package,
    grants: { capabilities: ["t3.ui/navigation.open"], projectIds: ["p"] },
  };
  const navigation = createNavigationClientProvider(
    {
      environmentId: ref.environmentId,
      client: "web",
      emit: () => {},
      installations: () => [installed],
    } as unknown as Parameters<typeof createNavigationClientProvider>[0],
    async () => {},
    undefined,
    (disk.previewFile ?? (async () => "opened")) as never,
    () => disk.previewSupported ?? true,
  );
  useNavigation(async (request, signal) => {
    const answer = await navigation.invoke({
      method: request.method,
      input: request.input,
      context: request.context,
      caller,
      signal,
    } as unknown as Parameters<typeof navigation.invoke>[0]);
    if (request.method !== "getCapabilities") return answer;
    // The server adapter's part: the invoking client's answer, as an operation.
    const { openFileInBrowser } = answer as { openFileInBrowser: boolean };
    return {
      adapter: "host.ui.navigation",
      operations: { openThread: true, openAgentSession: true, openFile: true, openFileInBrowser },
      clients: [],
    };
  });
  let stopPresentationClient = registerInstalledApiClient(
    ref.environmentId,
    "t3.files",
    host as never,
  );
  const cleanups = [
    registerWorkspaceExtension(files.client(host) as never, undefined, {
      environmentId: ref.environmentId,
    }),
    () => stopPresentationClient(),
  ];
  setInstalledApiPolicy(ref.environmentId, {
    apiSelections: [],
    apiResolution: [{ id: "t3.file/presentation", providerId: "t3.files" }],
  } as never);
  useRightPanelStore.setState({
    byThreadKey: {},
    extensionDockByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  function App() {
    const store = useRightPanelStore();
    const surface = selectSelectedRightPanelSurface(store.byThreadKey, ref);
    return surface ? (
      <NativeRightPanel
        surface={surface as Parameters<typeof NativeRightPanel>[0]["surface"]}
        threadRef={ref}
        context={panelContext}
        visible
        bindings={{ files: { surface, hasProject: true, cwd: "/fixture" } } as never}
      />
    ) : null;
  }
  const viewports: FakeViewport[] = [];
  /** Tree rows that were given DOM focus, by name. */
  const focused: string[] = [];
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(<App />, {
      createNodeMock: (element) => {
        if (disk.viewportHeight === undefined) return null;
        const props = element.props as { "aria-label"?: string; children?: unknown };
        if (element.type === "ul" && props["aria-label"] === "Workspace files") {
          const viewport = new FakeViewport(disk.viewportHeight);
          viewports.push(viewport);
          return viewport;
        }
        if (element.type === "button") {
          const name = [props.children].flat().join("");
          return { focus: () => focused.push(name) };
        }
        return null;
      },
    });
  });
  const tree = root!;
  return {
    calls,
    focused,
    /** The tree's current scrolling element. */
    viewport: () => viewports.at(-1)!,
    refreshPresentationProvider() {
      stopPresentationClient();
      stopPresentationClient = registerInstalledApiClient(
        ref.environmentId,
        "t3.files",
        host as never,
      );
    },
    /** Remounts the panel from its persisted state, as a reload does. */
    async reload() {
      await act(async () => tree.update(<></>));
      await act(async () => tree.update(<App />));
    },
    /** A host file link: the navigation provider's `openFile`. */
    async navigation(input: { relativePath: string; line?: number }) {
      await navigation.invoke({
        method: "openFile",
        input,
        context,
        caller,
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof navigation.invoke>[0]);
    },
    editor: () => tree.root.findByProps({ "aria-label": "File editor" }),
    text: () => JSON.stringify(tree.toJSON()),
    frames: () => tree.root.findAllByType("iframe").length,
    editors: () => tree.root.findAllByProps({ "aria-label": "File editor" }).length,
    button: (label: string) =>
      tree.root.findAllByType("button").find((button) => button.children.includes(label)),
    /** The first control whose accessible name is `label`. */
    labelled: (label: string) => tree.root.findAllByProps({ "aria-label": label }).at(0),
    /** Visible rows of the workspace tree, as rendered text. */
    rows: () =>
      tree.root
        .findByProps({ "aria-label": "Workspace files" })
        .findAllByType("button")
        .map((row) => row.children.join("")),
    async unmount() {
      await act(async () => {
        tree.unmount();
        for (const cleanup of cleanups) cleanup();
        setInstalledApiPolicy(ref.environmentId, null);
      });
    },
  };
}

type Panel = Awaited<ReturnType<typeof mountPanel>>;

/** Edits the open file and lets autosave land on a conflict. */
async function conflictedEdit(panel: Panel, contents: string) {
  await act(async () => {
    panel.editor().props.onChange(contents);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(panel.calls.saves).toBe(1);
  expect(panel.text()).toContain("Keep my version");
}

const editorState = (panel: Panel) => ({
  contents: panel.editor().props.contents as string,
  conflict: panel.text().includes("Keep my version"),
  saves: panel.calls.saves,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reopening a file that is already open", () => {
  const USER_EDIT = "one\ntwo\nthree";

  const open = async (path: string) => {
    vi.useFakeTimers();
    const panel = await mountPanel({
      files: { [path]: "disk copy" },
      save: () => ({ kind: "conflict" }),
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, path));
      expect(panel.editor().props.contents).toBe("disk copy");
      await conflictedEdit(panel, USER_EDIT);
    } catch (error) {
      await panel.unmount();
      throw error;
    }
    return panel;
  };

  // The pack's own toolbar action.
  it("keeps the conflicted buffer when Files opens its own file in the panel", async () => {
    const panel = await open("toolbar.txt");
    try {
      await act(async () => panel.button("Open in panel")!.props.onClick());
      expect(editorState(panel)).toEqual({ contents: USER_EDIT, conflict: true, saves: 1 });
      expect(panel.calls.reads).toBe(1);
    } finally {
      await panel.unmount();
    }
  });

  it("keeps the conflicted buffer when a host file link names the open file", async () => {
    const panel = await open("link.txt");
    try {
      await act(async () => panel.navigation({ relativePath: "link.txt" }));
      expect(editorState(panel)).toEqual({ contents: USER_EDIT, conflict: true, saves: 1 });
      expect(panel.calls.reads).toBe(1);
    } finally {
      await panel.unmount();
    }
  });

  it("reveals a linked line in the open file without dropping the conflicted buffer", async () => {
    const panel = await open("line.txt");
    try {
      await act(async () => panel.navigation({ relativePath: "line.txt", line: 2 }));
      expect(editorState(panel)).toEqual({ contents: USER_EDIT, conflict: true, saves: 1 });
      // Line 2 starts after "one\n".
      expect(panel.editor().props.reveal).toMatchObject({ line: 2 });
      // A later link without a line focuses the same view: nothing re-reads.
      const reads = panel.calls.reads;
      await act(async () => panel.navigation({ relativePath: "line.txt" }));
      expect(editorState(panel)).toEqual({ contents: USER_EDIT, conflict: true, saves: 1 });
      expect(panel.calls.reads).toBe(reads);
    } finally {
      await panel.unmount();
    }
  });
});

// An open aimed at the file view that is
// already showing goes to that view in place. Its editor, and whatever it has
// not saved yet, stays; a different file is selected in it.
describe("a file link to the open file view", () => {
  it.each([
    { outcome: { kind: "conflict" }, conflict: true },
    { outcome: { kind: "error", message: "disk full" }, conflict: false },
  ])(
    "keeps edits whose save is still pending, settling as $outcome.kind",
    async ({ outcome, conflict }) => {
      vi.useFakeTimers();
      let finishSave!: (outcome: unknown) => void;
      const panel = await mountPanel({
        files: { "pending.txt": "disk copy" },
        save: () =>
          new Promise((resolve) => {
            finishSave = resolve;
          }),
      });
      try {
        await act(async () => panel.navigation({ relativePath: "pending.txt" }));
        // Dirty: the autosave debounce has not fired yet.
        await act(async () => panel.editor().props.onChange("one\ntwo"));
        await act(async () => panel.navigation({ relativePath: "pending.txt", line: 2 }));
        expect(editorState(panel)).toEqual({ contents: "one\ntwo", conflict: false, saves: 0 });
        // Saving: the flushed save is in flight when the next link lands.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        await act(async () => panel.editor().props.onChange("one\ntwo\n3"));
        await act(async () => panel.navigation({ relativePath: "pending.txt", line: 3 }));
        await act(async () => finishSave(outcome));
        expect(editorState(panel)).toEqual({ contents: "one\ntwo\n3", conflict, saves: 1 });
        expect(panel.calls.reads).toBe(1);
        expect(panel.calls.presentations).toHaveLength(3);
      } finally {
        await panel.unmount();
      }
    },
  );

  it("reveals each requested line, repeats included, in the same editor", async () => {
    const panel = await mountPanel({ files: { "lines.txt": "one\ntwo\nthree" } });
    try {
      await act(async () => panel.navigation({ relativePath: "lines.txt" }));
      const reveals: { line: number; requestId: number }[] = [];
      for (const line of [2, 3, 2, 2]) {
        await act(async () => panel.navigation({ relativePath: "lines.txt", line }));
        reveals.push(panel.editor().props.reveal);
      }
      // Lines 2 and 3 start at offsets 4 and 8.
      expect(reveals.map((reveal) => reveal.line)).toEqual([2, 3, 2, 2]);
      expect(new Set(reveals.map((reveal) => reveal.requestId)).size).toBe(4);
      expect(panel.calls.reads).toBe(1);
    } finally {
      await panel.unmount();
    }
  });

  it("selects the linked file when the view has moved to another one", async () => {
    const panel = await mountPanel({ files: { "a.txt": "file A", "b.txt": "file B" } });
    try {
      await act(async () => panel.navigation({ relativePath: "a.txt" }));
      await act(async () => panel.button("b.txt")!.props.onClick());
      expect(panel.editor().props.contents).toBe("file B");
      await act(async () => panel.navigation({ relativePath: "a.txt" }));
      expect(panel.editor().props.contents).toBe("file A");
    } finally {
      await panel.unmount();
    }
  });

  // Native parity: closing the tab disposes its edits; reopening reads the disk.
  it("starts from the disk after its tab was closed", async () => {
    vi.useFakeTimers();
    const panel = await mountPanel({
      files: { "closed.txt": "disk copy" },
      save: () => ({ kind: "conflict" }),
    });
    try {
      await act(async () => panel.navigation({ relativePath: "closed.txt" }));
      await conflictedEdit(panel, "abandoned edit");
      await act(async () => {
        useRightPanelStore.setState({ byThreadKey: {} });
      });
      await act(async () => panel.navigation({ relativePath: "closed.txt" }));
      expect(editorState(panel)).toEqual({ contents: "disk copy", conflict: false, saves: 1 });
    } finally {
      await panel.unmount();
    }
  });
});

// A failed open is shown beside the view
// it could not navigate, which keeps its unsaved edits.
describe("a file link the presentation provider rejects", () => {
  const failing = (files: Record<string, string>) => {
    const outage = { on: false };
    return {
      outage,
      disk: {
        files,
        presentationError: () => (outage.on ? new Error("provider offline") : undefined),
      },
    };
  };
  // A host file link (chat, timeline) opens the panel directly; an extension's
  // openFile learns of the failure itself (see "opening a file in the panel").
  const link = (relativePath: string, line?: number) =>
    act(async () => useRightPanelStore.getState().openFile(ref, relativePath, line));

  it("reports a failed change of file and clears it once an open succeeds", async () => {
    vi.useFakeTimers();
    const { outage, disk } = failing({ "a.txt": "file A", "b.txt": "file B" });
    const panel = await mountPanel(disk);
    try {
      await link("a.txt");
      await act(async () => panel.button("b.txt")!.props.onClick());
      await act(async () => panel.editor().props.onChange("unsaved B"));
      outage.on = true;
      await link("a.txt", 2);
      expect(panel.editor().props.contents).toBe("unsaved B");
      expect(panel.text()).toContain("provider offline");
      outage.on = false;
      await link("b.txt");
      expect(panel.editor().props.contents).toBe("unsaved B");
      expect(panel.text()).not.toContain("provider offline");
    } finally {
      await panel.unmount();
    }
  });

  it("reports a failed repeated line reveal and keeps the pending edit", async () => {
    vi.useFakeTimers();
    const { outage, disk } = failing({ "lines.txt": "one\ntwo\nthree" });
    const panel = await mountPanel(disk);
    try {
      await link("lines.txt", 2);
      await act(async () => panel.editor().props.onChange("one\ntwo!"));
      outage.on = true;
      await link("lines.txt", 2);
      expect(editorState(panel)).toEqual({ contents: "one\ntwo!", conflict: false, saves: 0 });
      expect(panel.text()).toContain("provider offline");
    } finally {
      await panel.unmount();
    }
  });
});

// An in-place open carries the view's saved
// settings; it does not replace them with the open's path.
describe("a file link to the path the view already shows", () => {
  it("keeps the view's saved choices across a reload", async () => {
    const panel = await mountPanel({ files: { "a.md": "# heading" } });
    try {
      await act(async () => panel.navigation({ relativePath: "a.md" }));
      await act(async () => panel.button("Show rendered markdown")!.props.onClick());
      await act(async () => panel.navigation({ relativePath: "a.md" }));
      expect(panel.button("Show markdown source")).toBeDefined();
      await panel.reload();
      expect({
        rendered: !!panel.button("Show markdown source"),
        source: !!panel.button("Show rendered markdown"),
      }).toEqual({ rendered: true, source: false });
    } finally {
      await panel.unmount();
    }
  });
});

// The preference's first answer, begun
// before the user chose, does not undo that choice; later changes still apply.
describe("an HTML file whose first preference answer arrives after a choice", () => {
  const view = { frames: 0, editors: 1 };
  const page = { frames: 1, editors: 0 };
  const rendered: Frame = {
    type: "snapshot",
    value: { wordWrap: false, renderBrowserFile: true },
  };
  const stubFetch = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
    );

  it.each(["read", "stream"] as const)(
    "keeps the source when the %s answers late",
    async (kind) => {
      stubFetch();
      let answer!: (frame: Frame) => void;
      const held = new Promise<Frame>((resolve) => {
        answer = resolve;
      });
      const silent = new Promise<Frame>(() => {});
      const panel = await mountPanel({
        files: { "late.html": "<p>source</p>" },
        preferences: kind === "stream" ? held : silent,
        preferencesRead: kind === "read" ? held : silent,
        preferenceWrite: new Promise(() => {}),
      });
      try {
        await act(async () => panel.navigation({ relativePath: "late.html" }));
        await act(async () => panel.button("Show HTML source")!.props.onClick());
        expect({ frames: panel.frames(), editors: panel.editors() }).toEqual(view);
        await act(async () => answer(rendered));
        expect({ frames: panel.frames(), editors: panel.editors() }).toEqual(view);
      } finally {
        await panel.unmount();
      }
    },
  );

  it("still follows a later change of the shared preference", async () => {
    stubFetch();
    let answer!: (frame: Frame) => void;
    const held = new Promise<Frame>((resolve) => {
      answer = resolve;
    });
    let change!: (frame: Frame) => void;
    const panel = await mountPanel({
      files: { "late.html": "<p>source</p>" },
      preferences: held,
      preferencesRead: new Promise(() => {}),
      preferenceChange: new Promise((resolve) => {
        change = resolve;
      }),
      preferenceWrite: new Promise(() => {}),
    });
    try {
      await act(async () => panel.navigation({ relativePath: "late.html" }));
      await act(async () => panel.button("Show HTML source")!.props.onClick());
      await act(async () => answer(rendered));
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual(view);
      await act(async () => change({ ...rendered, type: "data" }));
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual(page);
    } finally {
      await panel.unmount();
    }
  });
});

// A preference stream that never answers.
describe("an HTML file whose preference stream stays silent", () => {
  it("falls back to the view's own choice once the bounded read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const panel = await mountPanel({
      files: { "silent.html": "<p>source</p>" },
      preferences: new Promise(() => {}),
      preferencesRead: Promise.resolve(new Error("Client request timed out")),
    });
    try {
      await act(async () => panel.navigation({ relativePath: "silent.html" }));
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual({
        frames: 1,
        editors: 0,
      });
      await act(async () => panel.button("Show HTML source")!.props.onClick());
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual({
        frames: 0,
        editors: 1,
      });
    } finally {
      await panel.unmount();
    }
  });

  it("shows the source at once when the user asks, even with no answer at all", async () => {
    const panel = await mountPanel({
      files: { "silent.html": "<p>source</p>" },
      preferences: new Promise(() => {}),
      preferencesRead: new Promise(() => {}),
    });
    try {
      await act(async () => panel.navigation({ relativePath: "silent.html" }));
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual({
        frames: 0,
        editors: 0,
      });
      await act(async () => panel.button("Show HTML source")!.props.onClick());
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual({
        frames: 0,
        editors: 1,
      });
    } finally {
      await panel.unmount();
    }
  });
});

// A line link to an HTML file lands on its
// source at that line — without changing the shared rendered preference.
describe("a file link with a line", () => {
  it("opens an HTML file's source at the line in the selected Files presentation", async () => {
    const panel = await mountPanel({
      files: { "index.html": "<p>1</p>\n<p>2</p>\n<p>3</p>" },
    });
    try {
      await act(async () => panel.navigation({ relativePath: "index.html", line: 3 }));
      await act(async () => {});
      expect({ frames: panel.frames(), editors: panel.editors() }).toEqual({
        frames: 0,
        editors: 1,
      });
      expect(panel.editor().props.contents).toBe("<p>1</p>\n<p>2</p>\n<p>3</p>");
      expect(panel.editor().props.reveal).toMatchObject({ line: 3 });
      expect(panel.calls.log.filter(([, method]) => method === "setPreferences")).toEqual([]);
    } finally {
      await panel.unmount();
    }
  });
});

// Compatibility: a provider still on the 1.0.0 contract is sent the path it
// declared, never the 1.1.0 line its closed input would reject.
describe("a presentation provider on 1.0.0", () => {
  it("is asked for the path alone", async () => {
    const panel = await mountPanel({
      files: { "a.txt": "a" },
      presentationVersion: "1.0.0",
    });
    try {
      await act(async () => panel.navigation({ relativePath: "a.txt", line: 3 }));
      expect(
        panel.calls.presentations.map(({ versionRange, input }) => ({ versionRange, input })),
      ).toEqual([{ versionRange: "^1.0.0", input: { relativePath: "a.txt" } }]);
    } finally {
      await panel.unmount();
    }
  });
});

// The saved HTML choice decides the first
// frame. Until the preference answers, an HTML file shows neither its page
// nor its source.
describe("the first frame of an HTML file", () => {
  async function mountView(restoreState: unknown, preference: Promise<Frame | Error>) {
    const calls = newCalls();
    const { host } = packHost(
      { files: { "index.html": "<p>page</p>" }, preferences: preference },
      calls,
    );
    const stop = new AbortController();
    const session = {
      context: { ...context, resource: { ...context.resource, namespace: "t3.files" } },
      signal: stop.signal,
      visible: true,
      restoring: false,
      restoreState,
      onVisibility: () => () => {},
      save: () => true,
      publish: () => true,
      onDispose: () => {},
    } as unknown as ViewSession;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const Renderer = files.client(host).surfaces[0]!.createView(session).renderer;
    let root: ReactTestRenderer | undefined;
    await act(async () => {
      root = create(<Renderer />);
    });
    const tree = root!;
    return {
      shown: () => ({
        frames: tree.root.findAllByType("iframe").length,
        source: tree.root.findAllByProps({ "aria-label": "File editor" }).length,
      }),
      mints: () =>
        calls.log.filter(
          ([id, method]) => id === "t3.resources/lease" && method !== "getCapabilities",
        ).length,
      async unmount() {
        await act(async () => {
          stop.abort();
          tree.unmount();
        });
      },
    };
  }
  const held = () => {
    let settle!: (frame: Frame | Error) => void;
    const promise = new Promise<Frame | Error>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  };

  it("never mounts the page when the saved choice is source", async () => {
    const preference = held();
    const view = await mountView({ relativePath: "index.html" }, preference.promise);
    try {
      expect(view.shown()).toEqual({ frames: 0, source: 0 });
      await act(async () =>
        preference.settle({
          type: "snapshot",
          value: { wordWrap: false, renderBrowserFile: false },
        }),
      );
      expect(view.shown()).toEqual({ frames: 0, source: 1 });
      expect(view.mints()).toBe(0);
    } finally {
      await view.unmount();
    }
  });

  it("follows the shared choice over a restored view's older one", async () => {
    const preference = held();
    const view = await mountView(
      { relativePath: "index.html", renderHtml: false },
      preference.promise,
    );
    try {
      expect(view.shown()).toEqual({ frames: 0, source: 0 });
      await act(async () =>
        preference.settle({
          type: "snapshot",
          value: { wordWrap: false, renderBrowserFile: true },
        }),
      );
      expect(view.shown()).toEqual({ frames: 1, source: 0 });
    } finally {
      await view.unmount();
    }
  });

  it("falls back to the view's own choice on a host without the preference", async () => {
    for (const answer of [
      { type: "snapshot", value: { wordWrap: false } },
      new Error("API capability denied: t3.ui/preferences.read"),
    ]) {
      const preference = held();
      const view = await mountView({ relativePath: "index.html" }, preference.promise);
      try {
        expect(view.shown()).toEqual({ frames: 0, source: 0 });
        await act(async () => preference.settle(answer));
        expect(view.shown()).toEqual({ frames: 1, source: 0 });
      } finally {
        await view.unmount();
      }
    }
  });
});

// The Diff panel is product UI; its SDK
// plumbing notes do not ship in it.
describe.skipIf(diff === null)("the Diff panel", () => {
  it("renders no SDK slice notice", async () => {
    const calls = newCalls();
    const { host } = packHost({ files: {} }, calls);
    const stop = new AbortController();
    const session = {
      context: { ...context, resource: { ...context.resource, namespace: "t3.diff" } },
      signal: stop.signal,
      visible: true,
      restoring: false,
      restoreState: null,
      onVisibility: () => () => {},
      save: () => true,
      publish: () => true,
      onDispose: () => {},
    } as unknown as ViewSession;
    const Renderer = diff!.client(host).surfaces[0]!.createView(session).renderer;
    let root: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        root = create(<Renderer />);
      });
      expect(root!.root.findAllByProps({ "aria-label": "Slice notice" })).toHaveLength(0);
      expect(JSON.stringify(root!.toJSON())).not.toContain("t3.vcs/diff 1.1");
    } finally {
      await act(async () => {
        stop.abort();
        root?.unmount();
      });
    }
  });
});

// Native parity (FileBrowserPanel): one toolbar control expands every folder
// in the tree, then collapses them all again.
describe("expanding and collapsing every folder", () => {
  it("toggles every folder from one control, as the native tree does", async () => {
    const panel = await mountPanel({
      directories: ["src", "src/lib", "docs"],
      files: { "src/lib/deep.ts": "x", "src/top.ts": "y", "docs/guide.md": "z", "root.txt": "r" },
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "root.txt"));
      expect(panel.rows()).toEqual(["▸ docs/", "▸ src/", "root.txt"]);
      expect(panel.labelled("Expand all folders")).toBeDefined();
      await act(async () => panel.labelled("Expand all folders")!.props.onClick());
      expect(panel.rows()).toEqual([
        "▾ docs/",
        "guide.md",
        "▾ src/",
        "▾ lib/",
        "deep.ts",
        "top.ts",
        "root.txt",
      ]);
      expect(panel.labelled("Expand all folders")).toBeUndefined();
      await act(async () => panel.labelled("Collapse all folders")!.props.onClick());
      expect(panel.rows()).toEqual(["▸ docs/", "▸ src/", "root.txt"]);
      expect(panel.labelled("Expand all folders")).toBeDefined();
    } finally {
      await panel.unmount();
    }
  });

  it("names the collapse once every folder is open by hand", async () => {
    const panel = await mountPanel({
      directories: ["src"],
      files: { "src/a.ts": "a", "b.ts": "b" },
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "b.ts"));
      expect(panel.labelled("Expand all folders")).toBeDefined();
      const folder = panel.labelled("Workspace files")!.findAllByType("button")[0]!;
      await act(async () => folder.props.onClick());
      expect(panel.labelled("Collapse all folders")).toBeDefined();
      await act(async () => folder.props.onClick());
      expect(panel.labelled("Expand all folders")).toBeDefined();
    } finally {
      await panel.unmount();
    }
  });

  // Expand-all past the saved-folder bound
  // still stands after a reload.
  it("keeps every folder open across a reload, past the saved-folder bound", async () => {
    const names = Array.from({ length: 600 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const panel = await mountPanel({
      directories: names,
      files: Object.fromEntries(names.map((name) => [`${name}/f.txt`, "f"])),
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "d000/f.txt"));
      await act(async () => panel.labelled("Expand all folders")!.props.onClick());
      const folder = panel.labelled("Workspace files")!.findAllByType("button")[0]!;
      // One folder closed by hand stays closed; every other one stays open.
      await act(async () => folder.props.onClick());
      await panel.reload();
      expect(panel.rows().slice(0, 3)).toEqual(["▸ d000/", "▾ d001/", "f.txt"]);
      await act(async () =>
        panel.labelled("Workspace files")!.findAllByType("button")[0]!.props.onClick(),
      );
      expect(panel.labelled("Collapse all folders")).toBeDefined();
    } finally {
      await panel.unmount();
    }
  });

  // Expand-all over a 25,000-entry tree
  // mounts only the rows around the viewport, as native's virtualized tree does.
  it("mounts a bounded window of a 25,000-entry tree and still reaches every row", async () => {
    const names = Array.from({ length: 1000 }, (_, i) => `d${String(i).padStart(3, "0")}`);
    const files: Record<string, string> = {};
    for (const name of names)
      for (let file = 0; file < 24; file++)
        files[`${name}/f${String(file).padStart(2, "0")}.txt`] = "f";
    const panel = await mountPanel({ directories: names, files });
    const list = () => panel.labelled("Workspace files")!;
    const key = (name: string) =>
      act(async () => list().props.onKeyDown({ key: name, preventDefault() {} }));
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "d000/f00.txt"));
      expect(panel.text()).toContain("25000 entries");
      await act(async () => panel.labelled("Expand all folders")!.props.onClick());
      expect(panel.rows().length).toBeLessThan(100);
      expect(panel.rows().slice(0, 2)).toEqual(["▾ d000/", "f00.txt"]);
      // Scrolling moves the window.
      await act(async () => list().props.onScroll({ currentTarget: { scrollTop: 300_000 } }));
      expect(panel.rows().length).toBeLessThan(100);
      expect(panel.rows()).not.toContain("▾ d000/");
      // A row in the scrolled window selects its file.
      const far = list()
        .findAllByType("button")
        .filter((row) => !row.children.join("").startsWith("▾"))[10]!;
      const farName = far.children.join("");
      await act(async () => far.props.onClick());
      const selectedRows = () =>
        list()
          .findAllByType("button")
          .filter((row) => row.props["aria-current"] === "true")
          .map((row) => row.children.join(""));
      expect(selectedRows()).toEqual([farName]);
      expect(panel.rows().length).toBeLessThan(100);
      // Keys move through rows that were never mounted.
      await act(async () =>
        panel.labelled("Workspace files")!.findAllByType("button")[0]!.props.onFocus(),
      );
      await key("End");
      expect(panel.rows().at(-1)).toBe("f23.txt");
      await key("Home");
      expect(panel.rows()[0]).toBe("▾ d000/");
      await key("ArrowDown");
      await key("ArrowLeft");
      await key("ArrowLeft");
      expect(panel.rows().slice(0, 2)).toEqual(["▸ d000/", "▾ d001/"]);
      await key("ArrowRight");
      expect(panel.rows().slice(0, 2)).toEqual(["▾ d000/", "f00.txt"]);
      // A file opened far away is revealed in the tree.
      await act(async () => panel.labelled("Collapse all folders")!.props.onClick());
      expect(panel.rows().length).toBeLessThan(100);
      await act(async () => panel.navigation({ relativePath: "d987/f12.txt" }));
      expect(selectedRows()).toEqual(["f12.txt"]);
      expect(panel.rows().length).toBeLessThan(100);
    } finally {
      await panel.unmount();
    }
  }, 30_000);

  it("offers no control when the tree has no folders", async () => {
    const panel = await mountPanel({ files: { "only.txt": "o" } });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "only.txt"));
      expect(panel.labelled("Expand all folders")).toBeUndefined();
      expect(panel.labelled("Collapse all folders")).toBeUndefined();
    } finally {
      await panel.unmount();
    }
  });
});

// Native parity (FilePreviewPanel): the file explorer beside an open file
// can be hidden and shown again, and the choice survives a reload.
describe("hiding the file explorer", () => {
  const explorer = (panel: Panel) => ({
    tree: panel.labelled("Workspace files") !== undefined,
    search: panel.labelled("Search workspace files") !== undefined,
    hide: panel.button("Hide file explorer")?.props["aria-pressed"],
    show: panel.button("Show file explorer")?.props["aria-pressed"],
  });

  it("hides the tree and its search, then shows them again", async () => {
    const panel = await mountPanel({ files: { "a.txt": "a", "b.txt": "b" } });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
      expect(explorer(panel)).toEqual({ tree: true, search: true, hide: true, show: undefined });
      await act(async () => panel.button("Hide file explorer")!.props.onClick());
      expect(explorer(panel)).toEqual({ tree: false, search: false, hide: undefined, show: false });
      expect(panel.editors()).toBe(1);
      await panel.reload();
      expect(explorer(panel)).toEqual({ tree: false, search: false, hide: undefined, show: false });
      await act(async () => panel.button("Show file explorer")!.props.onClick());
      expect(explorer(panel)).toEqual({ tree: true, search: true, hide: true, show: undefined });
    } finally {
      await panel.unmount();
    }
  });
});

// The host presents a file once, before
// opening its view, and the view takes that presentation rather than asking
// the provider (server discovery and package verification) again.
describe("opening a file in the panel", () => {
  it("asks the presentation provider once per open", async () => {
    const panel = await mountPanel({ files: { "a.txt": "file A", "app.ts": "app" } });
    try {
      await act(async () => panel.navigation({ relativePath: "a.txt" }));
      expect(panel.calls.presentations).toHaveLength(1);
      expect(panel.editor().props.contents).toBe("file A");
      await act(async () => useRightPanelStore.getState().open(ref, "files"));
      await act(async () => panel.button("app.ts")!.props.onClick());
      const before = panel.calls.presentations.length;
      // The Files pack's own open, with its own view context.
      await act(async () => panel.button("Open in panel")!.props.onClick());
      expect(panel.calls.presentations).toHaveLength(before + 1);
      expect(panel.editor().props.contents).toBe("app");
    } finally {
      await panel.unmount();
    }
  });
});

// Web re-proof (Files 20): "Open in panel" that the presentation cannot serve
// toasts the failure, as native does, and opens no tab showing the error.
describe("opening a file in the panel when the presentation refuses", () => {
  it("toasts the failure and opens no tab", async () => {
    const denied = { on: false };
    const panel = await mountPanel({
      files: { "app.ts": "app" },
      presentationError: () =>
        denied.on ? new Error("API capability denied: t3.file/open") : undefined,
    });
    try {
      await act(async () => useRightPanelStore.getState().open(ref, "files"));
      await act(async () => panel.button("app.ts")!.props.onClick());
      denied.on = true;
      await act(async () => panel.button("Open in panel")!.props.onClick());
      expect(panel.calls.notifications).toEqual([
        {
          severity: "error",
          title: "Unable to open file",
          body: "Open is denied — Needs permission t3.file/open. Grant it in Settings → Extensions.",
          durationMs: 5_000,
          anchor: "thread",
          threadId: "t",
        },
      ]);
      const surfaces =
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces ?? [];
      expect(surfaces.map((surface) => surface.id)).toEqual(["files"]);
      expect(panel.text()).not.toContain("capability denied");
    } finally {
      await panel.unmount();
    }
  });
});

describe("already-open file tabs after presentation grant changes", () => {
  it("names the revoked grant and re-reads when permission returns", async () => {
    const denied = { on: false };
    const disk = { "app.ts": "original contents" };
    const panel = await mountPanel({
      files: disk,
      presentationError: () =>
        denied.on ? new Error("API capability denied: t3.file/open") : undefined,
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "app.ts"));
      expect(panel.editor().props.contents).toBe("original contents");
      expect(panel.calls.reads).toBe(1);

      denied.on = true;
      await act(async () => panel.refreshPresentationProvider());
      expect(panel.text()).toContain(
        "Needs permission t3.file/open. Grant it in Settings → Extensions.",
      );
      expect(panel.text()).not.toContain("API capability denied");
      expect(panel.editors()).toBe(0);
      expect(panel.calls.reads).toBe(1);

      disk["app.ts"] = "updated after permission returns";
      denied.on = false;
      await act(async () => panel.refreshPresentationProvider());
      expect(panel.editor().props.contents).toBe("updated after permission returns");
      expect(panel.calls.reads).toBe(2);
      expect(panel.calls.presentations).toHaveLength(3);
      expect(panel.text()).not.toContain("Needs permission");
    } finally {
      await panel.unmount();
    }
  });
});

// The explorer choice is the native file
// preview's shared one, read when a view opens and written when toggled.
describe("the shared file explorer choice", () => {
  const shownWith = (fileExplorerOpen: boolean): Promise<Frame> =>
    Promise.resolve({
      type: "snapshot",
      value: { wordWrap: false, renderBrowserFile: true, fileExplorerOpen },
    });

  it("starts hidden in a new view when the native panel hid it", async () => {
    const panel = await mountPanel({ files: { "a.txt": "a" }, preferences: shownWith(false) });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
      expect(panel.labelled("Workspace files")).toBeUndefined();
      expect(panel.button("Show file explorer")).toBeDefined();
    } finally {
      await panel.unmount();
    }
  });

  it("writes each choice where the native panel and new views read it", async () => {
    const panel = await mountPanel({
      files: { "a.txt": "a" },
      preferences: shownWith(true),
      preferenceWrite: Promise.resolve({ applied: true, preferences: { wordWrap: false } }),
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
      expect(panel.labelled("Workspace files")).toBeDefined();
      await act(async () => panel.button("Hide file explorer")!.props.onClick());
      await act(async () => panel.button("Show file explorer")!.props.onClick());
      expect(panel.calls.preferenceWrites).toEqual([
        { fileExplorerOpen: false },
        { fileExplorerOpen: true },
      ]);
      expect(panel.labelled("Workspace files")).toBeDefined();
    } finally {
      await panel.unmount();
    }
  });
});

// Native parity (FilePreviewPanel "Open file in preview browser"): a page
// opens in the thread's preview browser through t3.ui/navigation.
describe("opening a file in the preview browser", () => {
  const stubFetch = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
    );

  it("offers it for pages only and opens the page from the workspace root", async () => {
    stubFetch();
    const previews: unknown[][] = [];
    const panel = await mountPanel({
      files: { "site/page.html": "<p>page</p>", "notes.txt": "n" },
      previewFile: async (...args) => {
        previews.push(args);
        return "opened";
      },
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "notes.txt"));
      expect(panel.button("Open file in preview browser")).toBeUndefined();
      await act(async () => useRightPanelStore.getState().openFile(ref, "site/page.html"));
      expect(panel.button("Open file in preview browser")).toBeDefined();
      await act(async () => panel.button("Open file in preview browser")!.props.onClick());
      expect(previews).toEqual([[ref, "/fixture/site/page.html", "/fixture"]]);
      expect(panel.text()).not.toContain("cannot be opened");
    } finally {
      await panel.unmount();
    }
  });

  // A client that loses its preview browser after saying it had one still
  // refuses, and the refusal is named.
  it("names a browser that cannot open the page", async () => {
    stubFetch();
    const panel = await mountPanel({
      files: { "page.html": "<p>page</p>" },
      previewFile: async () => "browser-unavailable",
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "page.html"));
      expect(panel.button("Open file in preview browser")).toBeDefined();
      await act(async () => panel.button("Open file in preview browser")!.props.onClick());
      expect(panel.calls.notifications).toMatchObject([
        {
          title: "Unable to open file in browser",
          body: "page.html cannot be opened — The preview browser is unavailable in this client",
        },
      ]);
    } finally {
      await panel.unmount();
    }
  });
});

// As native, the action shows only on a client
// with a preview browser, and only where the host can say so.
describe("a client without a preview browser", () => {
  it.each([
    ["a web client", { previewSupported: false }],
    ["a host whose navigation predates the question", { navigationVersion: "1.1.0" }],
  ])("offers no preview-browser open on %s", async (_name, client) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const panel = await mountPanel({ files: { "page.html": "<p>page</p>" }, ...client });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "page.html"));
      expect(panel.button("Open in panel")).toBeDefined();
      expect(panel.button("Open file in preview browser")).toBeUndefined();
    } finally {
      await panel.unmount();
    }
  });
});

// A reload restores the latest line a link
// revealed, as native's persisted `revealLine` does, not the view's first one.
describe("a line revealed after the view opened", () => {
  it("is the line a reload reveals", async () => {
    const panel = await mountPanel({ files: { "reveal.txt": "one\ntwo\nthree" } });
    try {
      await act(async () => panel.navigation({ relativePath: "reveal.txt", line: 2 }));
      expect(panel.editor().props.reveal).toMatchObject({ line: 2 });
      await act(async () => panel.navigation({ relativePath: "reveal.txt", line: 3 }));
      expect(panel.editor().props.reveal).toMatchObject({ line: 3 });
      await panel.reload();
      expect(panel.editor().props.reveal).toMatchObject({ line: 3 });
    } finally {
      await panel.unmount();
    }
  });
});

// A restored line reveal outranks a restored
// rendered-markdown preference, as native's reveal does, until the user
// chooses the rendered view again.
describe("a markdown file reopened at a revealed line", () => {
  it("shows the source at that line, then renders when asked", async () => {
    const panel = await mountPanel({ files: { "notes.md": "# one\ntwo\nthree" } });
    const mode = () => ({
      rendered: !!panel.button("Show markdown source"),
      editor: panel.editors(),
    });
    try {
      await act(async () => panel.navigation({ relativePath: "notes.md", line: 3 }));
      expect(panel.editor().props.reveal).toMatchObject({ line: 3 });
      await act(async () => panel.button("Show rendered markdown")!.props.onClick());
      expect(mode()).toEqual({ rendered: true, editor: 0 });
      await panel.reload();
      expect(mode()).toEqual({ rendered: false, editor: 1 });
      expect(panel.editor().props.reveal).toMatchObject({ line: 3 });
      await act(async () => panel.button("Show rendered markdown")!.props.onClick());
      expect(mode()).toEqual({ rendered: true, editor: 0 });
    } finally {
      await panel.unmount();
    }
  });
});

// The tree's window follows its scrolling
// element when the element comes back, and a row revealed while it was gone
// is scrolled to once it shows.
describe("a long tree whose explorer is hidden and shown", () => {
  const disk = () => {
    const files: Record<string, string> = {};
    for (let file = 0; file < 1000; file++) files[`f${String(file).padStart(3, "0")}.txt`] = "f";
    return { files, viewportHeight: 240 };
  };
  const list = (panel: Panel) => panel.labelled("Workspace files")!;
  /** Tops of the mounted rows that fall inside the viewport. */
  const visibleTops = (panel: Panel) => {
    const { scrollTop, clientHeight } = panel.viewport();
    return list(panel)
      .findAllByType("li")
      .map((row) => (row.props.style as { top?: number } | undefined)?.top)
      .filter((top): top is number => top !== undefined)
      .filter((top) => top + 24 > scrollTop && top < scrollTop + clientHeight);
  };
  const toggle = (panel: Panel, label: string) =>
    act(async () => panel.button(label)!.props.onClick());

  it("keeps full windowed positions on treeitems and the older host's six-pixel inset", async () => {
    const panel = await mountPanel(disk());
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "f000.txt"));
      const rows = list(panel).findAllByProps({ role: "treeitem" });
      expect(rows.length).toBeLessThan(1000);
      expect(rows[0]!.props["aria-setsize"]).toBe(1000);
      expect(rows[0]!.props["aria-posinset"]).toBe(1);
      const box = list(panel)
        .findAllByType("li")
        .find((node) => node.props.style.position === "absolute")!;
      expect(box.props.style.left).toBe(6);
      expect(rows[0]!.props.style.color).toBe("var(--t3-files-text, var(--foreground, #20252d))");
    } finally {
      await panel.unmount();
    }
  });

  it("shows the rows at its scroll position again", async () => {
    const panel = await mountPanel(disk());
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "f000.txt"));
      const viewport = panel.viewport();
      viewport.scrollTop = 12_000;
      await act(async () => list(panel).props.onScroll({ currentTarget: viewport }));
      expect(visibleTops(panel)).toHaveLength(10);
      await toggle(panel, "Hide file explorer");
      await toggle(panel, "Show file explorer");
      expect(panel.viewport()).not.toBe(viewport);
      expect(panel.viewport().scrollTop).toBe(12_000);
      expect(visibleTops(panel)).toHaveLength(10);
    } finally {
      await panel.unmount();
    }
  });

  it("scrolls to a file opened while it was hidden", async () => {
    const panel = await mountPanel(disk());
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "f000.txt"));
      await toggle(panel, "Hide file explorer");
      await act(async () => panel.navigation({ relativePath: "f999.txt" }));
      await toggle(panel, "Show file explorer");
      expect(visibleTops(panel)).toContain(999 * 24);
      expect(panel.viewport().scrollTop).toBe(1000 * 24 - 240);
    } finally {
      await panel.unmount();
    }
  });
});

// The focused row going away moves keyboard
// focus to the nearest row that remains, as native's tree does.
describe("a tree whose focused row goes away", () => {
  const rowNamed = (panel: Panel, name: string) =>
    panel
      .labelled("Workspace files")!
      .findAllByType("button")
      .find((row) => row.children.join("") === name)!;
  const focus = (panel: Panel, name: string) =>
    act(async () => rowNamed(panel, name).props.onFocus());
  const arrowDown = async (panel: Panel) => {
    let handled = false;
    await act(async () =>
      panel.labelled("Workspace files")!.props.onKeyDown({
        key: "ArrowDown",
        preventDefault: () => {
          handled = true;
        },
      }),
    );
    return handled;
  };
  const refresh = (panel: Panel) =>
    act(async () => panel.labelled("Refresh workspace files")!.props.onClick());

  it("focuses the row now in its place when it is deleted or renamed", async () => {
    const disk = { files: { "a.txt": "a", "b.txt": "b", "c.txt": "c" } as Record<string, string> };
    const panel = await mountPanel({ ...disk, viewportHeight: 240 });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
      await focus(panel, "b.txt");
      delete disk.files["b.txt"];
      await refresh(panel);
      expect(panel.rows()).toEqual(["a.txt", "c.txt"]);
      expect(panel.focused.at(-1)).toBe("c.txt");
      // The keys carry on from there.
      await focus(panel, "a.txt");
      expect(await arrowDown(panel)).toBe(true);
      expect(panel.focused.at(-1)).toBe("c.txt");
      // A rename takes the same place when it sorts there.
      delete disk.files["c.txt"];
      disk.files["d.txt"] = "d";
      await refresh(panel);
      expect(panel.rows()).toEqual(["a.txt", "d.txt"]);
      expect(panel.focused.at(-1)).toBe("d.txt");
      // The last row going leaves focus on the one before it.
      delete disk.files["d.txt"];
      await refresh(panel);
      expect(panel.focused.at(-1)).toBe("a.txt");
      expect(await arrowDown(panel)).toBe(true);
    } finally {
      await panel.unmount();
    }
  });

  it("focuses its folder when the folder closes over it", async () => {
    const panel = await mountPanel({
      directories: ["src"],
      files: { "src/a.txt": "a", "src/b.txt": "b", "z.txt": "z" },
      viewportHeight: 240,
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "z.txt"));
      await act(async () => panel.labelled("Expand all folders")!.props.onClick());
      await focus(panel, "b.txt");
      await act(async () => panel.labelled("Collapse all folders")!.props.onClick());
      expect(panel.rows()).toEqual(["▸ src/", "z.txt"]);
      expect(panel.focused.at(-1)).toBe("▸ src/");
      expect(await arrowDown(panel)).toBe(true);
      expect(panel.focused.at(-1)).toBe("z.txt");
    } finally {
      await panel.unmount();
    }
  });
});

describe("Files kit regressions", () => {
  it.each([false, true])(
    "keeps exactly one reachable tab stop after scrolling and blur (kit=%s)",
    async (kit) => {
      const panel = await mountPanel({
        directories: Array.from({ length: 200 }, (_, i) => `folder${String(i).padStart(3, "0")}`),
        files: { "open.txt": "open" },
        viewportHeight: 240,
        ...(kit ? { uiKit: alternateKit } : {}),
      });
      try {
        await act(async () => useRightPanelStore.getState().openFile(ref, "open.txt"));
        const list = () => panel.labelled("Workspace files")!;
        const stops = () =>
          list()
            .findAllByType("button")
            .filter((row) => row.props.tabIndex === 0);
        await act(async () => stops()[0]!.props.onFocus());
        for (let i = 0; i < 80; i++)
          await act(async () => list().props.onKeyDown({ key: "ArrowDown", preventDefault() {} }));
        expect(stops()).toHaveLength(1);
        await act(async () => stops()[0]!.props.onBlur({ currentTarget: { isConnected: true } }));
        expect(stops()).toHaveLength(1);
        panel.viewport().scrollTop = 180 * 24;
        await act(async () => list().props.onScroll({ currentTarget: panel.viewport() }));
        expect(stops()).toHaveLength(1);
        expect(list().findAllByType("button").length).toBeLessThan(100);
      } finally {
        await panel.unmount();
      }
    },
  );

  it("opens every part of a flattened chain and preserves it when a sibling appears", async () => {
    const directories = ["src", "src/lib"];
    const panel = await mountPanel({
      files: { "open.txt": "open" },
      directories,
      uiKit: alternateKit,
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "open.txt"));
      const row = panel
        .labelled("Workspace files")!
        .findAllByType("button")
        .find((row) => row.children.join("") === "src/lib")!;
      await act(async () => row.props.onClick());
      expect(panel.labelled("Collapse all folders")).toBeDefined();
      directories.push("src/other");
      await act(async () => panel.labelled("Refresh workspace files")!.props.onClick());
      const src = panel
        .labelled("Workspace files")!
        .findAllByType("button")
        .find((row) => row.children.join("") === "src")!;
      expect(src.props["aria-expanded"]).toBe(true);
      expect(panel.rows()).toContain("lib");
    } finally {
      await panel.unmount();
    }
  });

  it("uses the kit for file actions and save-conflict controls while preserving edits", async () => {
    vi.useFakeTimers();
    const panel = await mountPanel({
      files: { "a.txt": "disk" },
      uiKit: alternateKit,
      save: () => ({ kind: "conflict" }),
    });
    try {
      await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
      expect(panel.button("Open in panel")!.props["data-kit-variant"]).toBe("outline");
      await conflictedEdit(panel, "my edit");
      expect(panel.button("Keep my version")!.props["data-kit-variant"]).toBe("outline");
      expect(panel.button("Reload file")!.props["data-kit-variant"]).toBe("outline");
      expect(panel.editor().props.contents).toBe("my edit");
    } finally {
      await panel.unmount();
    }
  });
});

it("uses kit editor controls and still opens the chosen remote editor", async () => {
  const panel = await mountPanel({
    files: { "a.txt": "file" },
    externalEditor: true,
    uiKit: alternateKit,
  });
  try {
    await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
    const controls = panel.labelled("File actions")!.findAllByType("button");
    const main = controls.find((button) => button.children.join("") === "Open in VS Code")!;
    expect(main.props["data-kit-variant"]).toBe("outline");
    expect(controls.some((button) => button.children.join("") === "Cursor")).toBe(false);
    await act(async () => panel.labelled("Choose editor")!.props.onClick());
    const menu = panel.labelled("File actions")!.findByProps({ "data-editor-menu-open": true });
    expect(menu.findByType("p").children.join("")).toBe("Remote workspace");
    const cursor = menu
      .findAllByProps({ role: "menuitem" })
      .find((button) => button.children.join("") === "Cursor")!;
    await act(async () => cursor.props.onClick());
    expect(panel.calls.log).toContainEqual(["t3.ui/editor", "openPath"]);
    expect(
      panel
        .labelled("File actions")!
        .findAllByType("button")
        .some((button) => button.children.join("") === "Open in Cursor"),
    ).toBe(true);
  } finally {
    await panel.unmount();
  }
});

it("keeps browser-default fallback file actions and conflict recovery controls", async () => {
  vi.useFakeTimers();
  const panel = await mountPanel({
    files: { "a.txt": "disk" },
    save: () => ({ kind: "conflict" }),
  });
  try {
    await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
    expect(panel.button("Open in panel")!.props.style).toBeUndefined();
    expect(panel.button("Open in panel")!.props["data-t3-files-fallback-control"]).toBe("");
    await conflictedEdit(panel, "my edit");
    expect(panel.button("Keep my version")!.props.style).toBeUndefined();
    expect(panel.button("Reload file")!.props.style).toBeUndefined();
    expect(panel.editor().props.contents).toBe("my edit");
  } finally {
    await panel.unmount();
  }
});

describe("Files editor controls through the real client registration and server gate", () => {
  it.each([
    { name: "local primary", primary: true, visible: true, openPath: true, legacy: false },
    {
      name: "local secondary (native hides the picker)",
      primary: false,
      visible: false,
      openPath: false,
      legacy: false,
    },
    { name: "legacy client", primary: true, visible: false, openPath: false, legacy: true },
  ])("$name", async ({ primary, visible, openPath, legacy }) => {
    const installed = {
      id: "t3.files",
      contentHash: "h",
      installationGeneration: 1,
      enabled: true,
      grants: { capabilities: ["t3.ui/editor.open"], projectIds: [ProjectId.make("p")] },
      package: files.package,
    } as InstalledPackage;
    const previousEditor = getLocalStorageItem("t3code:last-editor", EditorId);
    persistPreferredEditor(EditorId.make("vscode"));
    const launches: unknown[] = [];
    const launcher: EditorLauncher = {
      availableEditors: () => [EditorId.make("vscode"), EditorId.make("cursor")],
      isPrimaryEnvironment: () => primary,
      remoteState: () => ({ mode: "local-exec" }),
      remoteEditors: async () => [],
      openRemoteUrl: async () => false,
      openInEditor: async (value) => {
        launches.push(value);
        return AsyncResult.success(undefined);
      },
    };
    const client = createEditorClientProvider(
      {
        environmentId: ref.environmentId,
        client: "web",
        emit: () => {},
        installations: () => [installed],
      },
      launcher,
    );
    const descriptors = legacy
      ? CLIENT_PROVIDER_DESCRIPTORS.map((entry) =>
          entry.id === "t3.client/editor" ? { ...entry, version: "1.0.0" } : entry,
        )
      : CLIENT_PROVIDER_DESCRIPTORS;
    const seam = await editorClientSeam(ref.environmentId, client, descriptors);
    let panel: Awaited<ReturnType<typeof mountPanel>> | undefined;
    try {
      const capabilities = (await seam.invoke(
        {
          id: uiEditorApi.definition.id,
          versionRange: "^1.1.0",
          method: "getCapabilities",
          input: {},
          context,
        },
        new AbortController().signal,
      )) as UiEditorCapabilities;
      expect(capabilities.operations.openPath).toBe(openPath);
      if (legacy) expect(capabilities.editor).toBeUndefined();
      else
        expect(capabilities.editor).toMatchObject({
          visible,
          remoteHint: null,
          preferredEditor: "vscode",
          editors: [
            { id: "cursor", label: "Cursor" },
            { id: "vscode", label: "VS Code" },
          ],
        });
      panel = await mountPanel({
        files: { "a.txt": "file" },
        uiKit: alternateKit,
        editorInvoke: seam.invoke,
      });
      await act(async () => useRightPanelStore.getState().openFile(ref, "a.txt"));
      expect(panel.labelled("Choose editor") !== undefined).toBe(visible);
      const open = panel
        .labelled("File actions")!
        .findAllByType("button")
        .find((button) => button.children.join("") === "Open in VS Code");
      expect(open !== undefined).toBe(visible);
      if (visible) {
        await act(async () => {
          open!.props.onClick();
          await seam.opened;
        });
        expect(launches).toEqual([
          { environmentId: ref.environmentId, input: { cwd: "/fixture/a.txt", editor: "vscode" } },
        ]);
        expect(panel.calls.log).toContainEqual(["t3.ui/editor", "openPath"]);
      }
    } finally {
      await panel?.unmount();
      await seam.dispose();
      if (previousEditor === null) removeLocalStorageItem("t3code:last-editor");
      else persistPreferredEditor(previousEditor);
    }
  });
});
