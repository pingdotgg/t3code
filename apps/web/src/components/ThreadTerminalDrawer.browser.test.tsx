import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import {
  EnvironmentId,
  ThreadId,
  type FilesystemGetMetadataResult,
  type ScopedThreadRef,
  type FilesystemEntryMetadata,
} from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { extractTerminalLinks } from "../terminal-links";
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
  metadataByEnvironment: new Map<EnvironmentId, FilesystemGetMetadataResult>(),
  pendingMetadata: new Map<string, Promise<FilesystemGetMetadataResult>>(),
  openEditor: vi.fn(async (_target: string) => ({ _tag: "Success" as const })),
  linkMetadata: new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>
  >(),
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
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  terminalIds?: string[];
  cwd?: string;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
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
  fixture.metadataByEnvironment = new Map();
  fixture.pendingMetadata = new Map();
  fixture.openEditor.mockClear();
  useRightPanelStore.setState({ byThreadKey: {} });
  fixture.linkMetadata.clear();
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
