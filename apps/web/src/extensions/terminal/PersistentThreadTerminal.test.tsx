import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  histories: new Set<string>(),
  archived: new Set<string>(),
}));

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const metadata = (ref: ScopedThreadRef) => ({
    environmentId: ref.environmentId,
    id: ref.threadId,
    projectId: "project-a",
    worktreePath: `/work/${ref.threadId}`,
  });
  const detail = Atom.family((key: string) =>
    Atom.make((get) => {
      fixture.histories.add(key);
      get.addFinalizer(() => fixture.histories.delete(key));
      return {
        ...metadata({ environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make(key) }),
        messages: [{ content: "retained history" }],
      };
    }).pipe(Atom.setIdleTTL(0)),
  );
  const shell = Atom.family((key: string) =>
    Atom.make(
      fixture.archived.has(key)
        ? null
        : metadata({ environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make(key) }),
    ),
  );
  return {
    environmentThreadDetails: { detailAtom: (ref: ScopedThreadRef) => detail(ref.threadId) },
    environmentThreadShells: { threadShellAtom: (ref: ScopedThreadRef) => shell(ref.threadId) },
  };
});
vi.mock("../../state/projects", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const project = Atom.make({ id: "project-a", workspaceRoot: "/work/project-a" });
  return { environmentProjects: { projectAtom: () => project } };
});
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: null }));
vi.mock("../../state/shell", () => ({
  allEnvironmentProjectSnapshotsReadyAtom: null,
  allEnvironmentShellsBootstrappedAtom: null,
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: () => null,
}));
vi.mock("../../state/terminalSessions", () => {
  const sessions: readonly never[] = [];
  return { useKnownTerminalSessions: () => sessions };
});
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: null, write: null, close: null },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("../../components/ThreadTerminalDrawer", () => ({
  default: ({ cwd }: { cwd: string }) => <span>{cwd}</span>,
}));

import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { PersistentThreadTerminalDrawer } from "./PersistentThreadTerminal";

let renderer: ReactTestRenderer | null = null;
let registry: AtomRegistry.AtomRegistry;

function drawer(threadId: string, active: boolean) {
  const ref = { environmentId: EnvironmentId.make("env-a"), threadId: ThreadId.make(threadId) };
  useTerminalUiStateStore.getState().setTerminalOpen(ref, true);
  return (
    <PersistentThreadTerminalDrawer
      key={threadId}
      threadRef={ref}
      threadId={ref.threadId}
      active={active}
      launchContext={null}
      focusRequestId={0}
      splitShortcutLabel={undefined}
      splitVerticalShortcutLabel={undefined}
      newShortcutLabel={undefined}
      closeShortcutLabel={undefined}
      keybindings={[]}
      onAddTerminalContext={() => {}}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.histories.clear();
  fixture.archived.clear();
  registry = AtomRegistry.make({ defaultIdleTTL: 0 });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("persistent terminal drawer history retention", () => {
  it("releases hidden histories when switching threads while retaining shell launch paths", async () => {
    const drawers = (active: string) => (
      <RegistryContext.Provider value={registry}>
        {drawer("thread-a", active === "thread-a")}
        {drawer("thread-b", active === "thread-b")}
      </RegistryContext.Provider>
    );
    await act(() => {
      renderer = create(drawers("thread-a"));
    });
    expect([...fixture.histories]).toEqual(["thread-a"]);
    expect(renderer!.root.findAllByType("span").map((node) => node.children)).toEqual([
      ["/work/thread-a"],
      ["/work/thread-b"],
    ]);
    await act(() => renderer!.update(drawers("thread-b")));
    expect([...fixture.histories]).toEqual(["thread-b"]);
    await act(() => renderer!.unmount());
    expect(fixture.histories.size).toBe(0);
  });

  it("retains the active archived thread's launch path even without a shell", async () => {
    fixture.archived.add("archived-thread");
    await act(() => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          {drawer("archived-thread", true)}
        </RegistryContext.Provider>,
      );
    });
    expect([...fixture.histories]).toEqual(["archived-thread"]);
    expect(renderer!.root.findByType("span").children).toEqual(["/work/archived-thread"]);
  });
});
