import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import {
  EnvironmentId,
  ThreadId,
  type FilesystemGetMetadataResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import type { GhosttyTerminalSurfaceOptions } from "../terminal/ghostty/surface";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  surfaceOptions: [] as GhosttyTerminalSurfaceOptions[],
  openFilesInApp: false,
  scopes: null as ReadonlySet<string> | null,
  metadata: { entries: [{ kind: "file" }] } as FilesystemGetMetadataResult,
  openEditor: vi.fn(async (_target: string) => ({ _tag: "Success" as const })),
}));

// Every surface method is a no-op; `then` stays undefined so awaiting the surface resolves to it.
const fakeSurface: object = new Proxy(
  { input: document.createElement("textarea") },
  {
    get: (target, key) =>
      key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => undefined,
  },
);
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: (_mount: HTMLElement, options: GhosttyTerminalSurfaceOptions) =>
      new Promise((resolve) => {
        fixture.surfaceOptions.push(options);
        fixture.pendingSurfaces.push(() => resolve(fakeSurface));
      }),
  },
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const sessions = Atom.family((_environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.make({
        ...EMPTY_TERMINAL_SESSION_STATE,
        status: fixture.statusByThreadId.get(threadId) ?? "closed",
        version: 1,
      }),
    ),
  );
  return {
    attachedTerminalSessionAtom: (environmentId: EnvironmentId, terminal: { threadId: ThreadId }) =>
      sessions(environmentId)(terminal.threadId),
  };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: (_environmentId: EnvironmentId, scope: string) =>
    fixture.scopes === null || fixture.scopes.has(scope),
  readEnvironmentScope: (_environmentId: EnvironmentId, scope: string) =>
    fixture.scopes === null || fixture.scopes.has(scope),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../state/terminal", () => ({ terminalEnvironment: { write: {}, resize: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => fixture.openEditor }));
vi.mock("../state/filesystem", () => ({ filesystemEnvironment: { getMetadata: {} } }));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: fixture.metadata }),
}));
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select({ ...DEFAULT_CLIENT_SETTINGS, terminalFileLinksOpenInApp: fixture.openFilesInApp }),
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd="/repo"
      height={240}
      terminalIds={["term-1"]}
      activeTerminalId="term-1"
      terminalGroups={[{ id: "group-1", terminalIds: ["term-1"] }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={() => {}}
      keybindings={[]}
    />
  );
}

function setup() {
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, "exited"],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.surfaceOptions = [];
  fixture.openFilesInApp = false;
  fixture.scopes = null;
  fixture.metadata = { entries: [{ kind: "file" }] };
  fixture.openEditor.mockClear();
  useRightPanelStore.setState({ byThreadKey: {} });
  return { original, other };
}

it.each([false, true])(
  "opens terminal file links using the saved in-app preference (%s)",
  async (openFilesInApp) => {
    const { original } = setup();
    fixture.openFilesInApp = openFilesInApp;
    await using _screen = await render(<Drawer threadRef={original} onCloseTerminal={() => {}} />);
    await act(async () => {
      fixture.pendingSurfaces.shift()?.();
    });
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate("src/example.ts:42:7", new MouseEvent("click"));
    });

    const panel = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      original,
    );
    if (openFilesInApp) {
      expect(panel).toMatchObject({
        kind: "file",
        relativePath: "/repo/src/example.ts",
        revealLine: 42,
      });
      expect(fixture.openEditor).not.toHaveBeenCalled();
    } else {
      expect(panel).toBeNull();
      expect(fixture.openEditor).toHaveBeenCalledWith("/repo/src/example.ts:42:7");
    }
  },
);

it.each(["modifier", "directory"])(
  "keeps the external editor available for a %s when file previews are enabled",
  async (reason) => {
    const { original } = setup();
    fixture.openFilesInApp = true;
    if (reason === "directory") fixture.metadata = { entries: [{ kind: "directory" }] };
    await using _screen = await render(<Drawer threadRef={original} onCloseTerminal={() => {}} />);
    await act(async () => {
      fixture.pendingSurfaces.shift()?.();
    });
    const mac = /mac/i.test(navigator.platform);
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate(
        "src/example.ts:42",
        new MouseEvent("click", {
          metaKey: reason === "modifier" && mac,
          ctrlKey: reason === "modifier" && !mac,
        }),
      );
    });
    expect(fixture.openEditor).toHaveBeenCalledWith("/repo/src/example.ts:42");
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, original),
    ).toBeNull();
  },
);

it("opens files on their owning environment with filesystem access and no editor-launch grant", async () => {
  const { original, other } = setup();
  fixture.openFilesInApp = true;
  fixture.scopes = new Set(["filesystem:read", "terminal:operate"]);
  await using _screen = await render(<Drawer threadRef={other} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const options = fixture.surfaceOptions[0]!;
  expect(options.canActivateLink?.("/repo/src/example.ts:42")).toBe(true);
  await act(() => {
    options.onLinkActivate("/repo/src/example.ts:42", new MouseEvent("click"));
  });
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, other),
  ).toMatchObject({
    kind: "file",
    relativePath: "/repo/src/example.ts",
    revealLine: 42,
  });
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, original),
  ).toBeNull();
  fixture.scopes = new Set(["terminal:operate"]);
  expect(options.canActivateLink?.("/repo/other.ts")).toBe(false);
  await act(() => {
    options.onLinkActivate("/repo/other.ts", new MouseEvent("click"));
  });
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, other),
  ).toMatchObject({
    relativePath: "/repo/src/example.ts",
  });
  expect(fixture.openEditor).not.toHaveBeenCalled();
});

it("closes an exited terminal on its own thread after navigating to one reusing its ID", async () => {
  const { original, other } = setup();
  const onCloseTerminal = vi.fn();
  await using screen = await render(
    <Drawer threadRef={original} onCloseTerminal={onCloseTerminal} />,
  );
  using _timers = fakeTimers();
  // The exit is seen once the surface loads, and its close waits for the next task.
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await screen.rerender(<Drawer threadRef={other} onCloseTerminal={onCloseTerminal} />);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(onCloseTerminal.mock.calls).toEqual([["term-1", original]]);
});
