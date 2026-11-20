import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_SESSION_STATE,
} from "@t3tools/client-runtime/state/terminal";
import {
  EnvironmentId,
  ThreadId,
  type FilesystemGetMetadataResult,
  type ScopedThreadRef,
  type FilesystemEntryMetadata,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { Atom, AsyncResult } from "effect/reactivity";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { extractTerminalLinks } from "../terminal-links";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import type { GhosttyTerminalSurfaceOptions } from "../terminal/ghostty/surface";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "starting" | "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  typeIntoSurface: null as ((data: string) => void) | null,
  pressKey: null as ((event: KeyboardEvent) => boolean) | null,
  writes: [] as Array<{ threadId: string; data: string }>,
  messages: [] as string[],
  resetSessions: () => {},
  setSession: (
    _thread: ScopedThreadRef,
    _status: "closed" | "starting" | "running",
    _version: number,
    _generation?: number,
  ) => {},
  sessionEvent: (_thread: ScopedThreadRef, _type: "snapshot" | "restarted", _pid = 123) => {},
  surfaceOptions: [] as GhosttyTerminalSurfaceOptions[],
  reportedSize: null as { cols: number; rows: number } | null,
  resizeCommand: {},
  runWrite: (): Promise<{ _tag: "Success" }> => Promise.resolve({ _tag: "Success" }),
  runResize: (_input: unknown): Promise<AsyncResult.AsyncResult<unknown, unknown>> =>
    Promise.resolve(AsyncResult.success(undefined)),
  openFilesInApp: false,
  scopes: null as ReadonlySet<string> | null,
  metadata: { entries: [{ kind: "file" }] } as FilesystemGetMetadataResult,
  metadataByEnvironment: new Map<EnvironmentId, FilesystemGetMetadataResult>(),
  pendingMetadata: new Map<string, Promise<FilesystemGetMetadataResult>>(),
  openEditor: vi.fn(async (_target: string) => ({ _tag: "Success" as const })),
  linkMetadata: new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>
  >(),
}));

// Every other surface method is a no-op; `then` stays undefined so awaiting the surface resolves to it.
const fakeSurface: object = new Proxy(
  {
    input: document.createElement("textarea"),
    write: (data: string) => fixture.messages.push(data),
    // The real surface re-reports its measured grid.
    resendSize: () => {
      const size = fixture.reportedSize;
      if (size) fixture.surfaceOptions.at(-1)!.onResize(size.cols, size.rows);
    },
  },
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
        fixture.pendingSurfaces.push(() => {
          fixture.typeIntoSurface = options.onData;
          fixture.pressKey = options.beforeKey ?? null;
          resolve(fakeSurface);
        });
      }),
  },
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  // A strong map, not Atom.family: a family holds weakly, so a GC could hand setSession a new atom.
  const summary = (threadId: ThreadId, pid: number) => ({
    threadId,
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running" as const,
    pid,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "Terminal 1",
    updatedAt: "2026-11-15T00:00:00.000Z",
  });
  const makeSession = (threadId: ThreadId) =>
    Atom.make<typeof EMPTY_TERMINAL_SESSION_STATE>({
      ...EMPTY_TERMINAL_SESSION_STATE,
      summary: summary(threadId, 123),
      status: fixture.statusByThreadId.get(threadId) ?? "closed",
      version: 1,
    });
  let sessions = new Map<string, ReturnType<typeof makeSession>>();
  const session = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const key = JSON.stringify([environmentId, threadId]);
    const atom = sessions.get(key) ?? makeSession(threadId);
    sessions.set(key, atom);
    return atom;
  };
  fixture.resetSessions = () => {
    sessions = new Map();
  };
  fixture.setSession = (thread, status, version, generation) => {
    appAtomRegistry.set(session(thread.environmentId, thread.threadId), {
      ...EMPTY_TERMINAL_SESSION_STATE,
      status,
      version,
      ...(generation === undefined
        ? {}
        : { output: { ...EMPTY_TERMINAL_SESSION_STATE.output, generation } }),
    });
  };
  fixture.sessionEvent = (thread, type, pid = 123) => {
    const atom = session(thread.environmentId, thread.threadId);
    const current = appAtomRegistry.get(atom);
    appAtomRegistry.set(atom, {
      ...current,
      summary: summary(thread.threadId, pid),
      ...applyTerminalAttachStreamEvent(current, {
        type,
        threadId: thread.threadId,
        terminalId: "term-1",
        snapshot: {
          threadId: thread.threadId,
          terminalId: "term-1",
          cwd: "/repo",
          worktreePath: null,
          status: "running",
          pid,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Terminal 1",
          updatedAt: "2026-11-15T00:00:00.000Z",
        },
      }),
    });
  };
  return {
    attachedTerminalSessionAtom: (environmentId: EnvironmentId, terminal: { threadId: ThreadId }) =>
      session(environmentId, terminal.threadId),
  };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: (_environmentId: EnvironmentId, scope: string) =>
    fixture.scopes === null || fixture.scopes.has(scope),
  readEnvironmentScope: (_environmentId: EnvironmentId, scope: string) =>
    fixture.scopes === null || fixture.scopes.has(scope),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (command: object) => async (args: { input: { threadId: string; data?: string } }) => {
      if (command === fixture.resizeCommand) return fixture.runResize(args);
      if (args.input.data !== undefined) {
        fixture.writes.push({ threadId: args.input.threadId, data: args.input.data });
        return fixture.runWrite();
      }
      return { _tag: "Success" };
    },
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { write: {}, resize: fixture.resizeCommand },
}));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => fixture.openEditor }));
vi.mock("../state/filesystem", () => ({ filesystemEnvironment: { getMetadata: {} } }));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner:
    () =>
    async ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { paths: readonly string[] };
    }) => ({
      _tag: "Success",
      value: await (fixture.pendingMetadata.get(input.paths[0]!) ??
        fixture.metadataByEnvironment.get(environmentId) ??
        fixture.metadata),
    }),
}));
vi.mock("../state/projects", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    projectEnvironment: {
      fileMetadata: ({
        environmentId,
        input,
      }: {
        environmentId: string;
        input: { path: string };
      }) => {
        const key = JSON.stringify([environmentId, input.path]);
        let atom = fixture.linkMetadata.get(key);
        if (!atom) {
          atom = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
            AsyncResult.success(null),
          );
          fixture.linkMetadata.set(key, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select({ ...DEFAULT_CLIENT_SETTINGS, terminalFileLinksOpenInApp: fixture.openFilesInApp }),
    ensureClientSettingsHydrated: async () => {},
    getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  terminalIds?: string[];
  cwd?: string;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  keybindings?: ResolvedKeybindingsConfig;
}) {
  const terminalIds = props.terminalIds ?? ["term-1"];
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd={props.cwd ?? "/repo"}
      height={240}
      terminalIds={terminalIds}
      activeTerminalId={terminalIds[0]!}
      terminalGroups={[{ id: "group-1", terminalIds }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={() => {}}
      keybindings={props.keybindings ?? []}
    />
  );
}

function setup(originalStatus: "starting" | "exited" = "exited") {
  fixture.resetSessions();
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make(`environment-a-${expect.getState().currentTestName}`),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make(`environment-b-${expect.getState().currentTestName}`),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, originalStatus],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.typeIntoSurface = null;
  fixture.pressKey = null;
  fixture.writes = [];
  fixture.messages = [];
  fixture.surfaceOptions = [];
  fixture.openFilesInApp = false;
  fixture.scopes = null;
  fixture.metadata = { entries: [{ kind: "file" }] };
  fixture.metadataByEnvironment = new Map();
  fixture.pendingMetadata = new Map();
  fixture.openEditor.mockClear();
  fixture.linkMetadata.clear();
  fixture.reportedSize = null;
  fixture.runResize = () => Promise.resolve(AsyncResult.success(undefined));
  fixture.runWrite = () => Promise.resolve({ _tag: "Success" });
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  useTerminalUiStateStore.setState(useTerminalUiStateStore.getInitialState());
  return { original, other };
}

it.each([
  [false, "src/example.ts:42:7", "/repo/src/example.ts"],
  [true, "src/example.ts:42:7", "/repo/src/example.ts"],
  [false, "file:///repo/src/example.ts#L42C7", "/repo/src/example.ts"],
  [true, "file:///repo/src/example.ts#L42C7", "/repo/src/example.ts"],
  [true, "file:///repo/src/example%20file.ts%3A9#L42C7", "/repo/src/example file.ts:9"],
] as const)(
  "opens terminal file links using the saved in-app preference (%s, %s)",
  async (openFilesInApp, link, expectedPath) => {
    const { original } = setup();
    fixture.openFilesInApp = openFilesInApp;
    await using _screen = await render(<Drawer threadRef={original} onCloseTerminal={() => {}} />);
    await act(async () => {
      fixture.pendingSurfaces.shift()?.();
    });
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate(link, new MouseEvent("click"));
    });

    const panel = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      original,
    );
    if (openFilesInApp) {
      expect(panel).toMatchObject({
        kind: "file",
        relativePath: expectedPath,
        revealLine: 42,
      });
      expect(fixture.openEditor).not.toHaveBeenCalled();
    } else {
      expect(panel).toBeNull();
      expect(fixture.openEditor).toHaveBeenCalledWith(
        link.startsWith("file:") ? link : "/repo/src/example.ts:42:7",
      );
    }
  },
);

it.each(["modifier", "directory", "missing", "other"])(
  "uses the external editor for %s links when file previews are enabled",
  async (reason) => {
    const { original } = setup();
    fixture.openFilesInApp = true;
    if (reason === "directory") fixture.metadata = { entries: [{ kind: "directory" }] };
    if (reason === "missing") fixture.metadata = { entries: [null] };
    if (reason === "other") fixture.metadata = { entries: [{ kind: "other" }] };
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

function deferredMetadata() {
  let resolve!: (result: FilesystemGetMetadataResult) => void;
  const promise = new Promise<FilesystemGetMetadataResult>((resolveResult) => {
    resolve = resolveResult;
  });
  return { promise, resolve };
}

it.each([
  ["file", "file", false],
  ["file", "directory", false],
  ["directory", "file", false],
  ["file", "modifier", false],
  ["file", "url", false],
  ["file", "file", true],
  ["file", "directory", true],
  ["directory", "file", true],
  ["file", "modifier", true],
  ["file", "url", true],
] as const)(
  "ignores stale %s metadata after a newer %s activation (split panes: %s)",
  async (olderKind, latestKind, splitPanes) => {
    const { original } = setup();
    fixture.openFilesInApp = true;
    const older = deferredMetadata();
    const latest = deferredMetadata();
    fixture.pendingMetadata.set("/repo/src/older.ts", older.promise);
    fixture.pendingMetadata.set("/repo/src/latest.ts", latest.promise);
    await using _screen = await render(
      <Drawer
        threadRef={original}
        terminalIds={splitPanes ? ["term-1", "term-2"] : ["term-1"]}
        onCloseTerminal={() => {}}
      />,
    );
    await act(async () => {
      for (const complete of fixture.pendingSurfaces.splice(0)) complete();
    });
    const olderOptions = fixture.surfaceOptions[0]!;
    const latestOptions = fixture.surfaceOptions[splitPanes ? 1 : 0]!;
    const mac = /mac/i.test(navigator.platform);
    await act(() => {
      olderOptions.onLinkActivate("src/older.ts", new MouseEvent("click"));
      latestOptions.onLinkActivate(
        latestKind === "url" ? "https://example.com" : "src/latest.ts:42",
        new MouseEvent("click", {
          metaKey: latestKind === "modifier" && mac,
          ctrlKey: latestKind === "modifier" && !mac,
        }),
      );
    });
    if (latestKind === "file" || latestKind === "directory") {
      await act(async () => {
        latest.resolve({ entries: [{ kind: latestKind }] });
        await latest.promise;
      });
    }
    const latestPanel = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      original,
    );
    if (latestKind === "file") {
      expect(latestPanel).toMatchObject({ relativePath: "/repo/src/latest.ts", revealLine: 42 });
    } else {
      expect(latestPanel).toBeNull();
    }
    await act(async () => {
      older.resolve({ entries: [{ kind: olderKind }] });
      await older.promise;
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, original),
    ).toEqual(latestPanel);
    expect(fixture.openEditor.mock.calls).toEqual(
      latestKind === "directory" || latestKind === "modifier" ? [["/repo/src/latest.ts:42"]] : [],
    );
  },
);

it.each([false, true])(
  "keeps a pending file click when another link is validated (split panes: %s)",
  async (splitPanes) => {
    const { original } = setup();
    fixture.openFilesInApp = true;
    const clicked = deferredMetadata();
    fixture.pendingMetadata.set("/repo/src/clicked.ts", clicked.promise);
    const validating = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.initial(),
    );
    fixture.linkMetadata.set(
      JSON.stringify([original.environmentId, "/repo/src/validating.ts"]),
      validating,
    );
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <Drawer
          threadRef={original}
          terminalIds={splitPanes ? ["term-1", "term-2"] : ["term-1"]}
          onCloseTerminal={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    await act(async () => {
      for (const complete of fixture.pendingSurfaces.splice(0)) complete();
    });
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate("src/clicked.ts:42", new MouseEvent("click"));
    });
    const validation =
      fixture.surfaceOptions[splitPanes ? 1 : 0]!.validateLink!("src/validating.ts");
    await act(async () => {
      clicked.resolve({ entries: [{ kind: "file" }] });
      await clicked.promise;
    });
    await act(() => {
      appAtomRegistry.set(validating, AsyncResult.success({ kind: "file" }));
    });
    expect(await validation).toBe(true);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, original),
    ).toMatchObject({ relativePath: "/repo/src/clicked.ts", revealLine: 42 });
    expect(fixture.openEditor).not.toHaveBeenCalled();
  },
);

it.each(["file", "directory"] as const)(
  "does not open a %s destination after its terminal closes",
  async (kind) => {
    const { original } = setup();
    fixture.openFilesInApp = true;
    const pending = deferredMetadata();
    fixture.pendingMetadata.set("/repo/src/example.ts", pending.promise);
    await using screen = await render(<Drawer threadRef={original} onCloseTerminal={() => {}} />);
    await act(async () => {
      fixture.pendingSurfaces.shift()?.();
    });
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate("src/example.ts", new MouseEvent("click"));
    });
    await screen.unmount();
    await act(async () => {
      pending.resolve({ entries: [{ kind }] });
      await pending.promise;
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, original),
    ).toBeNull();
    expect(fixture.openEditor).not.toHaveBeenCalled();
  },
);

it.each(["term-1", "term-2"])(
  "preserves link ordering when split pane %s closes during a lookup",
  async (closedTerminalId) => {
    const { original } = setup();
    fixture.openFilesInApp = true;
    const older = deferredMetadata();
    const latest = deferredMetadata();
    fixture.pendingMetadata.set("/repo/src/older.ts", older.promise);
    fixture.pendingMetadata.set("/repo/src/latest.ts", latest.promise);
    await using screen = await render(
      <Drawer threadRef={original} terminalIds={["term-1", "term-2"]} onCloseTerminal={() => {}} />,
    );
    await act(async () => {
      for (const complete of fixture.pendingSurfaces.splice(0)) complete();
    });
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate("src/older.ts", new MouseEvent("click"));
      fixture.surfaceOptions[1]!.onLinkActivate("src/latest.ts", new MouseEvent("click"));
    });
    await screen.rerender(
      <Drawer
        threadRef={original}
        terminalIds={[closedTerminalId === "term-1" ? "term-2" : "term-1"]}
        onCloseTerminal={() => {}}
      />,
    );
    const closed = closedTerminalId === "term-1" ? older : latest;
    const surviving = closedTerminalId === "term-1" ? latest : older;
    await act(async () => {
      closed.resolve({ entries: [{ kind: "file" }] });
      await closed.promise;
    });
    await act(async () => {
      surviving.resolve({ entries: [{ kind: "file" }] });
      await surviving.promise;
    });
    const panel = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      original,
    );
    if (closedTerminalId === "term-1") {
      expect(panel).toMatchObject({ relativePath: "/repo/src/latest.ts" });
    } else {
      expect(panel).toBeNull();
    }
    expect(fixture.openEditor).not.toHaveBeenCalled();
  },
);

it.each(["thread", "environment"])(
  "keeps pending link activations independent across %s scopes",
  async (scope) => {
    const { original, other } = setup();
    const independent =
      scope === "thread"
        ? { ...original, threadId: other.threadId }
        : { ...original, environmentId: other.environmentId };
    fixture.openFilesInApp = true;
    const older = deferredMetadata();
    fixture.pendingMetadata.set("/repo/src/older.ts", older.promise);
    await using _screen = await render(
      <>
        <Drawer threadRef={original} onCloseTerminal={() => {}} />
        <Drawer threadRef={independent} onCloseTerminal={() => {}} />
      </>,
    );
    await act(async () => {
      for (const complete of fixture.pendingSurfaces.splice(0)) complete();
    });
    await act(() => {
      fixture.surfaceOptions[0]!.onLinkActivate("src/older.ts", new MouseEvent("click"));
      fixture.surfaceOptions[1]!.onLinkActivate("src/latest.ts", new MouseEvent("click"));
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, independent),
    ).toMatchObject({ relativePath: "/repo/src/latest.ts" });
    await act(async () => {
      older.resolve({ entries: [{ kind: "file" }] });
      await older.promise;
    });
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, original),
    ).toMatchObject({ relativePath: "/repo/src/older.ts" });
    expect(fixture.openEditor).not.toHaveBeenCalled();
  },
);

it("opens files on their owning environment with filesystem access and no editor-launch grant", async () => {
  const { original, other } = setup();
  fixture.openFilesInApp = true;
  fixture.scopes = new Set(["filesystem:read", "terminal:operate"]);
  fixture.metadata = { entries: [null] };
  fixture.metadataByEnvironment.set(other.environmentId, { entries: [{ kind: "file" }] });
  await using _screen = await render(<Drawer threadRef={other} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const options = fixture.surfaceOptions[0]!;
  fixture.linkMetadata.set(
    JSON.stringify([other.environmentId, "/repo/src/example.ts"]),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  await act(() => options.onLinkHover!("/repo/src/example.ts:42"));
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
  await act(() => {
    options.onLinkActivate("/repo/other.ts", new MouseEvent("click"));
  });
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, other),
  ).toMatchObject({
    relativePath: "/repo/src/example.ts",
  });
  expect(fixture.openEditor).not.toHaveBeenCalled();
  fixture.scopes = new Set(["filesystem:read", "terminal:operate"]);
  fixture.linkMetadata.set(
    JSON.stringify([other.environmentId, "/repo/src"]),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "directory" }),
    ),
  );
  await act(() => options.onLinkHover!("/repo/src"));
  expect(options.canActivateLink?.("/repo/src")).toBe(false);
  expect(await options.validateLink!("/repo/src")).toBe(false);
});

it("drops input until the shell runs instead of failing a write for every key", async () => {
  const { original } = setup("starting");
  fixture.setSession(original, "closed", 0);
  await using _screen = await render(<Drawer threadRef={original} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const clearShortcut = () => new KeyboardEvent("keydown", { key: "l", ctrlKey: true });
  fixture.typeIntoSurface?.("before attach");
  fixture.pressKey?.(clearShortcut());
  await act(() => fixture.setSession(original, "running", 0));
  fixture.typeIntoSurface?.("stale metadata");
  fixture.pressKey?.(clearShortcut());
  await act(() => fixture.setSession(original, "starting", 1));
  fixture.typeIntoSurface?.("early");
  fixture.pressKey?.(clearShortcut());
  expect(fixture.writes).toEqual([]);
  await act(() => fixture.setSession(original, "running", 1));
  fixture.typeIntoSurface?.("ready");
  fixture.pressKey?.(clearShortcut());
  expect(fixture.writes).toEqual([
    { threadId: original.threadId, data: "ready" },
    { threadId: original.threadId, data: "\u000c" },
  ]);
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

// Thread navigation defaults have no `!terminalFocus`, so they apply in a focused terminal.
it("hands thread navigation shortcuts from a focused terminal back to the app", async () => {
  const { other: threadRef } = setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useRightPanelStore.getState().openBrowser(threadRef, null);
  await using _screen = await render(
    <Drawer
      threadRef={threadRef}
      onCloseTerminal={() => {}}
      keybindings={compileResolvedKeybindingsConfig([
        ...DEFAULT_KEYBINDINGS,
        { key: "ctrl+r", command: "thread.next", when: "!previewOpen" },
        { key: "ctrl+g", command: "thread.previous", when: "terminalOpen" },
      ])}
    />,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const terminalHandles = (key: string, code: string, shiftKey = true) =>
    fixture.surfaceOptions
      .at(-1)!
      .beforeKey(new KeyboardEvent("keydown", { key, code, ctrlKey: true, shiftKey }));

  expect([terminalHandles("{", "BracketLeft"), terminalHandles("}", "BracketRight")]).toEqual([
    false,
    false,
  ]);
  expect(terminalHandles("C", "KeyC")).toBe(true);
  // Sidebar sees the open preview and the closed drawer and rejects these, so the shell keeps them.
  expect([terminalHandles("r", "KeyR", false), terminalHandles("g", "KeyG", false)]).toEqual([
    true,
    true,
  ]);
});

it("only activates terminal paths confirmed to exist on their environment", async () => {
  const { other: threadRef } = setup();
  const key = (path: string) => JSON.stringify([threadRef.environmentId, path]);
  const pending = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
    AsyncResult.initial(),
  );
  fixture.linkMetadata.set(key("/repo/src/main.ts"), pending);
  fixture.linkMetadata.set(
    key("/repo/src/…notes.ts"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  fixture.linkMetadata.set(
    key("/repo/src"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "directory" }),
    ),
  );
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const canActivate = (text: string) => fixture.surfaceOptions.at(-1)!.canActivateLink!(text);
  const validate = (text: string) => fixture.surfaceOptions.at(-1)!.validateLink!(text);
  const hover = (text: string | null) =>
    act(() => fixture.surfaceOptions.at(-1)!.onLinkHover!(text));

  expect(canActivate("https://example.com")).toBe(true);
  for (const branch of ["t3/fix-html-image-details", "t3/fix-html-…mage-details"]) {
    const candidates = extractTerminalLinks(branch);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(canActivate(candidate.text)).toBe(false);
      await hover(candidate.text);
      expect(canActivate(candidate.text)).toBe(false);
      expect(await validate(candidate.text)).toBe(false);
    }
  }
  const pressedValidation = validate("src/main.ts:12:7");
  await hover("src/main.ts:12:7");
  expect(canActivate("src/main.ts:12:7")).toBe(false);
  await act(() => {
    fixture.surfaceOptions.at(-1)!.onLinkActivate("https://example.com", new MouseEvent("click"));
  });
  await act(async () => {
    appAtomRegistry.set(pending, AsyncResult.success({ kind: "file" }));
  });
  expect(canActivate("src/main.ts:12:7")).toBe(true);
  expect(await pressedValidation).toBe(false);
  expect(canActivate("missing/file.ts")).toBe(false);
  await hover("missing/file.ts");
  expect(canActivate("missing/file.ts")).toBe(false);
  for (const path of ["/repo/src/…notes.ts", "/repo/src"]) {
    await hover(path);
    expect(canActivate(path)).toBe(true);
  }
  await hover(null);
  expect(canActivate("/repo/src")).toBe(false);
  fixture.linkMetadata.set(
    key("/home/alice/notes.ts"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  await screen.rerender(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} cwd="/home/alice/project" onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  expect(await validate("~/notes.ts:5:2")).toBe(true);
  await hover("~/notes.ts:5:2");
  expect(canActivate("~/notes.ts:5:2")).toBe(true);
});

it("drops the rest of a split paste when the shell restarts mid-paste", async () => {
  const { other: threadRef } = setup();
  let settleWrite = () => {};
  fixture.runWrite = () =>
    new Promise((resolve) => {
      settleWrite = () => resolve({ _tag: "Success" });
    });
  await using _screen = await render(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  fixture.typeIntoSurface?.("p".repeat(70_000));
  await act(async () => {
    fixture.sessionEvent(threadRef, "restarted");
    settleWrite();
  });
  fixture.typeIntoSurface?.("after");
  expect(fixture.writes.map(({ data }) => data.length)).toEqual([65_536, 5]);
});

it.each([
  { pid: 123, closes: true },
  { pid: 456, closes: false },
])(
  "closes interrupted bracket framing only for its process (PID $pid)",
  async ({ pid, closes }) => {
    const { other: threadRef } = setup();
    let settleWrite = () => {};
    fixture.runWrite = () =>
      new Promise((resolve) => {
        settleWrite = () => {
          fixture.runWrite = () => Promise.resolve({ _tag: "Success" });
          resolve({ _tag: "Success" });
        };
      });
    await using _screen = await render(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
    await act(async () => {
      fixture.pendingSurfaces.shift()?.();
    });
    const large = `\x1b[200~${"p".repeat(70_000)}\x1b[201~`;
    fixture.typeIntoSurface?.(large);
    await act(async () => {
      fixture.sessionEvent(threadRef, "snapshot", pid);
      settleWrite();
    });
    await act(async () => {
      fixture.typeIntoSurface?.("after");
    });
    expect(
      fixture.messages.filter((message) => message.includes("paste interrupted")),
    ).toHaveLength(1);
    expect(fixture.writes.map(({ data }) => data)).toEqual([
      large.slice(0, 65_536),
      ...(closes ? ["\x1b[201~"] : []),
      "after",
    ]);
  },
);

it("closes an interrupted paste after disposal before input from a remounted view", async () => {
  const { other: threadRef } = setup();
  let settleWrite = () => {};
  fixture.runWrite = () =>
    new Promise((resolve) => {
      settleWrite = () => {
        fixture.runWrite = () => Promise.resolve({ _tag: "Success" });
        resolve({ _tag: "Success" });
      };
    });
  await using screen = await render(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const large = `\x1b[200~${"p".repeat(70_000)}\x1b[201~`;
  fixture.typeIntoSurface?.(large);
  fixture.typeIntoSurface?.("stale");
  await screen.rerender(<div />);
  await act(async () => {
    settleWrite();
  });
  await screen.rerender(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await act(async () => {
    fixture.typeIntoSurface?.("after");
  });
  expect(fixture.writes.map(({ data }) => data.length)).toEqual([65_536, 6, 5]);
});

it("resends a failed resize once in each writable session", async () => {
  const { other: threadRef } = setup();
  const resizes: unknown[] = [];
  const failure = AsyncResult.failure(Cause.die(new Error("resize rejected")));
  let failFirstResize = () => {};
  fixture.runResize = (input) => {
    resizes.push(input);
    if (resizes.length > 1) return Promise.resolve(failure);
    return new Promise((resolve) => {
      failFirstResize = () => resolve(failure);
    });
  };
  await using _screen = await render(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await act(async () => {
    fixture.reportedSize = { cols: 57, rows: 41 };
    fixture.surfaceOptions.at(-1)!.onResize(57, 41);
  });
  // The first request fails while the attachment reconnects, so its retry is not sent.
  await act(async () => {
    fixture.setSession(threadRef, "running", 0, 1);
    failFirstResize();
  });
  expect(resizes).toHaveLength(1);
  await act(async () => {
    fixture.setSession(threadRef, "running", 1, 2);
  });
  const resize = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, terminalId: "term-1", cols: 57, rows: 41 },
  };
  expect(resizes).toEqual([resize, resize, resize]);
});
