import { createContext, Suspense, useContext, useState, type ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { createDiffExtension, type DiffBindings } from ".";
import DiffPanel from "../../components/DiffPanel";
import { useDiffPanelStore } from "../../diffPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import type { AnnotatableCodeView } from "../../components/diffs/AnnotatableCodeView";

const fixture = vi.hoisted(() => ({
  refresh: vi.fn(),
  checkpoint: vi.fn(),
  updateSettings: vi.fn(),
  isRepo: true,
  missingThread: false,
  error: null as string | null,
  pending: false,
  truncated: false,
  patch: "",
  checkpointPatch: "",
  checkpointError: null as string | null,
  queryInputs: [] as unknown[],
  focusListeners: new Set<() => void>(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  // The mocked server config atom is null; every other atom (review file patches) stays real.
  const useAtomValue = ((atom: Parameters<typeof actual.useAtomValue>[0]) =>
    atom === null
      ? { availableEditors: [] }
      : actual.useAtomValue(atom)) as typeof actual.useAtomValue;
  return { ...actual, useAtomValue };
});
vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select: (params: object) => unknown }) =>
    select({ environmentId: "environment-a", threadId: "thread-a" }),
}));
vi.mock("../../state/entities", () => ({
  useThread: () =>
    fixture.missingThread
      ? null
      : {
          environmentId: "environment-a",
          id: "thread-a",
          projectId: "project-a",
          worktreePath: "/fixture",
        },
  useProject: () => ({ workspaceRoot: "/fixture" }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("../../state/review", () => ({
  reviewEnvironment: {
    diffPreview: (input: unknown) => ({ kind: "preview", input }),
    diffFileContents: "contents",
  },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: {
    status: () => ({ kind: "status" }),
    listRefs: () => ({ kind: "refs" }),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { kind: string; input?: unknown } | null) => {
    if (!query) return { data: undefined, refresh: fixture.refresh };
    if (query?.kind === "preview") {
      fixture.queryInputs.push(query.input);
      return {
        data: {
          cwd: "/fixture",
          generatedAt: DateTime.makeUnsafe("2026-09-09T00:00:00.000Z"),
          sources: ["working-tree", "branch-range"].map((kind) => ({
            kind,
            diff: fixture.patch,
            truncated: fixture.truncated,
          })),
        },
        error: fixture.error,
        isPending: fixture.pending,
        refresh: fixture.refresh,
      };
    }
    return {
      data: query?.kind === "status" ? { isRepo: fixture.isRepo } : { refs: [] },
      refresh: fixture.refresh,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({ diffLayout: "split", wordWrap: false, diffIgnoreWhitespace: false }),
  useUpdateClientSettings: () => fixture.updateSettings,
}));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => useState(false) }));
vi.mock("../../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: [
      { turnId: "turn-a", checkpointTurnCount: 1, completedAt: "2026-09-09T00:00:00Z", files: [] },
    ],
    inferredCheckpointTurnCountByTurnId: {},
  }),
}));
vi.mock("../../lib/checkpointDiffState", () => ({
  useCheckpointDiff: (input: unknown, options: unknown) => {
    fixture.checkpoint(input, options);
    return {
      data: { diff: fixture.checkpointPatch },
      error: fixture.checkpointError,
      isPending: false,
    };
  },
}));
vi.mock("../../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../../components/diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: ComponentProps<typeof AnnotatableCodeView>) => (
    <section aria-label="Fixture code view">
      {props.files.map((file) => (
        <span key={file.fileKey}>{file.filePath}</span>
      ))}
    </section>
  ),
}));
vi.mock("../../components/diffs/DiffFileTree", () => ({ DiffFileTree: () => <aside /> }));
vi.mock("../../components/DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));
vi.mock("../../components/ui/menu", async () => {
  const { control, radioGroup, radioItem } = await import("./testControls");
  return {
    ...Object.fromEntries(
      [
        "DropdownMenu",
        "DropdownMenuContent",
        "DropdownMenuItem",
        "DropdownMenuSub",
        "DropdownMenuSubContent",
        "DropdownMenuSubTrigger",
        "DropdownMenuTrigger",
      ].map((name) => [name, control]),
    ),
    DropdownMenuRadioGroup: radioGroup,
    DropdownMenuRadioItem: radioItem,
  };
});
vi.mock("../../components/ui/tooltip", async () => {
  const { control } = await import("./testControls");
  return { Tooltip: control, TooltipPopup: control, TooltipTrigger: control };
});
vi.mock("../../components/ui/combobox", async () => {
  const { control } = await import("./testControls");
  return Object.fromEntries(
    [
      "Combobox",
      "ComboboxEmpty",
      "ComboboxInput",
      "ComboboxSearchInput",
      "ComboboxItem",
      "ComboboxList",
      "ComboboxPopup",
      "ComboboxTrigger",
    ].map((name) => [name, control]),
  );
});
vi.mock("../../components/ui/button", async () => ({
  Button: (await import("./testControls")).control,
}));
vi.mock("../../components/ui/toggle-group", async () => {
  const { control } = await import("./testControls");
  return { ToggleGroup: control, Toggle: control };
});
vi.mock("../../components/ui/switch", async () => ({
  Switch: (await import("./testControls")).control,
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const initialBindings: DiffBindings = {
  panelKey: "environment-a:thread-a",
  composerDraftTarget: threadRef,
  workspaceMutationId: null,
};
const BindingsContext = createContext(initialBindings);
const record: ViewRecord = {
  version: 1,
  surfaceId: "t3.diff/view",
  placement: "side-panel",
  stateVersion: 1,
  context: {
    resource: {
      namespace: "t3.diff",
      id: "diff",
      environmentId: "environment-a",
      projectId: "project-a",
      threadId: "thread-a",
    },
    client: "web",
  },
  restoreState: null,
  fallback: "Diff unavailable",
};
const patch = [
  "diff --git a/changed.ts b/changed.ts",
  "index 1111111..2222222 100644",
  "--- a/changed.ts",
  "+++ b/changed.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");
const deletedPatch = [
  "diff --git a/deleted.ts b/deleted.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/deleted.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-deleted",
  "",
].join("\n");
const trees: ReactTestRenderer[] = [];
const hosts: ReturnType<typeof createExtensionHost<SurfaceRenderer>>[] = [];

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

async function mount(kind: "baseline" | "extension", bindings = initialBindings) {
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
  hosts.push(host);
  const useBindings = vi.fn(() => useContext(BindingsContext));
  const unregister = host.register(createDiffExtension(useBindings));
  const viewId = await host.open(record);
  expect(useBindings).not.toHaveBeenCalled();
  const render = (value: DiffBindings) => (
    <BindingsContext value={value}>
      {kind === "extension" ? (
        <ExtensionSurface host={host} viewId={viewId} />
      ) : (
        <Suspense fallback={null}>
          <DiffPanel
            key={value.panelKey}
            mode="embedded"
            composerDraftTarget={value.composerDraftTarget}
            workspaceMutationId={value.workspaceMutationId}
          />
        </Suspense>
      )}
    </BindingsContext>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render(bindings));
  });
  trees.push(tree);
  return {
    tree,
    host,
    viewId,
    unregister,
    useBindings,
    update: async (value: DiffBindings) => {
      await act(async () => tree.update(render(value)));
    },
  };
}

function button(tree: ReactTestRenderer, label: string) {
  const buttons = tree.root.findAllByType("button");
  return (buttons.find((node) => node.props["aria-label"] === label) ??
    buttons.find((node) => typeof node.props.onClick === "function" && text(node) === label))!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: (event: string, listener: () => void) => {
      if (event === "focus") fixture.focusListeners.add(listener);
    },
    removeEventListener: (event: string, listener: () => void) => {
      if (event === "focus") fixture.focusListeners.delete(listener);
    },
  });
  vi.clearAllMocks();
  fixture.patch = patch + deletedPatch;
  fixture.checkpointPatch = patch;
  fixture.error = null;
  fixture.checkpointError = null;
  fixture.pending = false;
  fixture.truncated = false;
  fixture.isRepo = true;
  fixture.missingThread = false;
  fixture.queryInputs = [];
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
  for (const host of hosts.splice(0)) host.dispose();
  expect(fixture.focusListeners.size).toBe(0);
  vi.unstubAllGlobals();
});

describe.each(["baseline", "extension"] as const)("%s native diff composition", (kind) => {
  it("selects working-tree, branch and checkpoint diffs through actual panel actions", async () => {
    const { tree } = await mount(kind);
    expect(button(tree, "Diff scope: Working tree")).toBeDefined();
    expect(text(tree.root)).toContain("changed.tsdeleted.ts");
    await act(async () => button(tree, "Refresh diff").props.onClick());
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    await act(async () => button(tree, "Branch changes").props.onClick());
    expect(button(tree, "Diff scope: Branch changes")).toBeDefined();
    await act(async () => button(tree, "Latest turn").props.onClick());
    expect(button(tree, "Diff scope: Latest turn")).toBeDefined();
    expect(text(tree.root)).not.toContain("deleted.ts");
    expect(fixture.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId: "environment-a",
        threadId: "thread-a",
        fromTurnCount: 0,
        toTurnCount: 1,
      }),
      { enabled: true },
    );
    expect(fixture.focusListeners.size).toBe(0);
    await act(async () => button(tree, "Working tree").props.onClick());
    expect(fixture.focusListeners.size).toBe(1);
  });

  it("refreshes own/sibling mutations once and cleans up the focus observer", async () => {
    const mounted = await mount(kind);
    for (const mutationId of ["own-turn", "own-turn", "sibling-turn"]) {
      await mounted.update({ ...initialBindings, workspaceMutationId: mutationId });
    }
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const listener of fixture.focusListeners) listener();
    });
    expect(fixture.refresh).toHaveBeenCalledTimes(3);
  });

  it("opens a changed source file through the existing host navigation action", async () => {
    class FileTitle {
      textContent = "changed.ts";
      hasAttribute(name: string) {
        return name === "data-title";
      }
    }
    vi.stubGlobal("HTMLElement", FileTitle);
    vi.stubGlobal("HTMLButtonElement", class extends FileTitle {});
    vi.stubGlobal("HTMLAnchorElement", class extends FileTitle {});
    const { tree } = await mount(kind);
    const fileArea = tree.root.find(
      (node) => node.type === "div" && typeof node.props.onClickCapture === "function",
    );
    await act(async () =>
      fileArea.props.onClickCapture({ nativeEvent: { composedPath: () => [new FileTitle()] } }),
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:changed.ts",
    });
  });

  it("keeps comparison controls and collapse state in the real panel", async () => {
    const { tree } = await mount(kind);
    await act(async () => button(tree, "Hide whitespace changes").props.onClick());
    expect(fixture.queryInputs.at(-1)).toMatchObject({ input: { ignoreWhitespace: true } });
    await act(async () => button(tree, "Collapse all files").props.onClick());
    expect(button(tree, "Expand all files")).toBeDefined();
    await act(async () => button(tree, "Expand all files").props.onClick());
    expect(button(tree, "Collapse all files")).toBeDefined();
  });

  it("passes binary and many-file patches through the existing parser", async () => {
    fixture.patch =
      Array.from({ length: 100 }, (_, index) =>
        patch.replaceAll("changed.ts", `file-${index}.ts`),
      ).join("") +
      "diff --git a/image.png b/image.png\nindex 1111111..2222222 100644\nBinary files a/image.png and b/image.png differ\n";
    const { tree } = await mount(kind);
    expect(text(tree.root)).toContain("file-99.ts");
    expect(text(tree.root)).toContain("image.png");
  });

  it.each([
    ["empty", "No net changes in this selection."],
    ["failed", "fixture read failed"],
    ["non-git", "Turn diffs are unavailable because this project is not a git repository."],
    ["missing-thread", "Select a thread to inspect turn diffs."],
    ["truncated", "This preview exceeds the size limit. Changes shown are incomplete."],
  ])("keeps the %s state visible", async (state, expected) => {
    if (state === "empty" || state === "failed") fixture.patch = "";
    if (state === "failed") fixture.error = "fixture read failed";
    if (state === "non-git") fixture.isRepo = false;
    if (state === "missing-thread") fixture.missingThread = true;
    if (state === "truncated") fixture.truncated = true;
    const { tree } = await mount(kind);
    expect(text(tree.root)).toContain(expected);
  });

  it("shows missing checkpoint failure without dispatching repository writes", async () => {
    fixture.checkpointPatch = "";
    fixture.checkpointError = "Checkpoint snapshot is missing";
    const { tree } = await mount(kind);
    await act(async () => button(tree, "Latest turn").props.onClick());
    expect(text(tree.root)).toContain("Checkpoint snapshot is missing");
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});

describe("registered diff lifecycle", () => {
  it("retains local wrap state across hide/show and unmounts on close", async () => {
    const { tree, host, viewId } = await mount("extension");
    const renderer = host.renderer(viewId);
    await act(async () => button(tree, "Enable diff line wrapping").props.onClick());
    await act(async () => host.hide(viewId));
    expect(host.renderer(viewId)).toBe(renderer);
    expect(tree.root.findAllByType("div")[0]?.props.hidden).toBe(true);
    expect(fixture.focusListeners.size).toBe(1);
    await act(async () => host.show(viewId));
    expect(button(tree, "Disable diff line wrapping")).toBeDefined();
    await act(async () => host.close(viewId));
    expect(fixture.focusListeners.size).toBe(0);
    expect(tree.root.findAllByType(DiffPanel)).toHaveLength(0);
  });

  it("disposes one viewer without tearing down another viewer", async () => {
    const first = await mount("extension");
    const secondId = await first.host.open(record);
    let secondTree!: ReactTestRenderer;
    await act(async () => {
      secondTree = create(<ExtensionSurface host={first.host} viewId={secondId} />);
    });
    trees.push(secondTree);
    expect(fixture.focusListeners.size).toBe(2);
    await act(async () => first.host.close(first.viewId));
    expect(fixture.focusListeners.size).toBe(1);
    expect(button(secondTree, "Refresh diff")).toBeDefined();
    await act(async () => first.unregister());
    expect(fixture.focusListeners.size).toBe(0);
    expect(first.host.getSnapshot(secondId)?.status).toBe("unavailable");
  });

  it("contains binding failures and can recover in a new generation", async () => {
    const mounted = await mount("extension");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mounted.useBindings.mockImplementation(() => {
        throw new Error("Diff bindings unavailable");
      });
      await mounted.update({ ...initialBindings, panelKey: "failure" });
      expect(mounted.host.getSnapshot(mounted.viewId)?.status).toBe("error");
      expect(text(mounted.tree.root)).toContain("Diff bindings unavailable");
      expect(fixture.focusListeners.size).toBe(0);
      mounted.useBindings.mockImplementation(() => useContext(BindingsContext));
      await act(async () =>
        mounted.host.updateContext(mounted.viewId, {
          ...record.context,
          workspaceRevision: "recovered",
        }),
      );
      expect(button(mounted.tree, "Refresh diff")).toBeDefined();
      expect(fixture.focusListeners.size).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resets local state on a new context generation and rejects non-native restore data", async () => {
    const { tree, host, viewId } = await mount("extension");
    await act(async () => button(tree, "Enable diff line wrapping").props.onClick());
    await act(async () =>
      host.updateContext(viewId, { ...record.context, workspaceRevision: "next" }),
    );
    expect(button(tree, "Enable diff line wrapping")).toBeDefined();
    expect(fixture.focusListeners.size).toBe(1);
    const invalidId = await host.open({ ...record, restoreState: { selection: "turn-a" } });
    expect(host.getSnapshot(invalidId)?.status).toBe("unavailable");
  });
});
