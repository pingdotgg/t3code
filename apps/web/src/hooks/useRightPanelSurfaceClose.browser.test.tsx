import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const fixture = vi.hoisted(() => ({
  confirm: (_labels: readonly string[]): Promise<boolean> => Promise.resolve(false),
  allowed: new Set<string>(),
  sessions: new Map<string, string>(),
  failClose: false,
}));
vi.mock("../lib/terminalCloseConfirm", () => ({
  confirmTerminalClose: (labels: readonly string[]) => fixture.confirm(labels),
}));
vi.mock("../components/ChatView.logic", () => ({
  agentControlledBrowserCloseConfirmation: () => null,
}));
vi.mock("../previewStateStore", () => ({
  useThreadPreviewState: () => ({ sessions: {}, desktopByTabId: {} }),
  setActivePreviewTab: () => {},
  beginPreviewSessionClose: () => {},
  cancelPreviewSessionClose: () => {},
}));
vi.mock("../browser/previewRuntime", () => ({ rendersServerTabNatively: () => false }));
vi.mock("../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null) };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: (id: string) => fixture.allowed.has(id),
  readEnvironmentScope: (id: string) => fixture.allowed.has(id),
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => null,
  useProject: () => null,
  readThreadShell: () => null,
}));
vi.mock("../state/terminalSessions", () => ({ useKnownTerminalSessions: () => null }));
vi.mock("../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    useComposerDraftStore: () => null,
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (_command: unknown, label: string) =>
    async (request: {
      environmentId: string;
      input: { threadId: string; terminalId: string; data?: string };
    }) => {
      const key = `${request.environmentId}/${request.input.threadId}/${request.input.terminalId}`;
      if (label === "terminal close" && fixture.failClose) return { _tag: "Failure" };
      if (label === "terminal close" || label === "terminal write") fixture.sessions.delete(key);
      return { _tag: "Success" };
    },
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/terminal", () => ({ terminalEnvironment: { open: {}, close: {}, write: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { close: {} } }));
vi.mock("../state/threads", () => ({ threadEnvironment: { delete: {} } }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
}));

function setup(mode: "single" | "all") {
  fixture.allowed = new Set(["environment-a", "environment-b"]);
  fixture.sessions = new Map();
  fixture.failClose = false;
  useRightPanelStore.setState({ byThreadKey: {} });
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  for (const ref of [original, other]) {
    fixture.sessions.set(`${ref.environmentId}/${ref.threadId}/term-1`, "history to preserve");
    useRightPanelStore.getState().openTerminal(ref, "term-1");
  }
  const surface = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, original)
    .surfaces[0]!;
  let resolve!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((done) => {
    resolve = done;
  });
  fixture.confirm = () => confirmation;
  function Harness({ threadRef }: { threadRef: ScopedThreadRef }) {
    const { closeSurface, closeAllSurfaces } = useRightPanelSurfaceClose({
      threadRef,
      terminalLabelsById: new Map(),
    });
    return (
      <button onClick={() => (mode === "all" ? closeAllSurfaces(surface) : closeSurface(surface))}>
        Close original terminal
      </button>
    );
  }
  return { original, other, Harness, resolve };
}

it.each([
  { mode: "single", failClose: false },
  { mode: "single", failClose: true },
  { mode: "all", failClose: false },
  { mode: "all", failClose: true },
] as const)(
  "keeps a pending $mode close on its original environment and thread, fallback=$failClose",
  async ({ mode, failClose }) => {
    const { original, other, Harness, resolve } = setup(mode);
    fixture.failClose = failClose;
    await using screen = await render(<Harness threadRef={original} />);
    await screen.getByRole("button").click();
    expect(fixture.sessions.size).toBe(2);
    await screen.rerender(<Harness threadRef={other} />);
    await act(async () => {
      resolve(true);
    });
    expect([...fixture.sessions]).toEqual([
      ["environment-b/thread-b/term-1", "history to preserve"],
    ]);
    const panels = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(panels, original).surfaces).toEqual([]);
    expect(selectThreadRightPanelState(panels, other).surfaces).toHaveLength(1);
  },
);

it.each([
  { mode: "single", outcome: "cancel" },
  { mode: "single", outcome: "revoked" },
  { mode: "all", outcome: "cancel" },
  { mode: "all", outcome: "revoked" },
] as const)(
  "leaves both sessions intact when $mode confirmation is $outcome",
  async ({ mode, outcome }) => {
    const { original, other, Harness, resolve } = setup(mode);
    await using screen = await render(<Harness threadRef={original} />);
    await screen.getByRole("button").click();
    expect(fixture.sessions.size).toBe(2);
    await screen.rerender(<Harness threadRef={other} />);
    if (outcome === "revoked") fixture.allowed.delete(original.environmentId);
    await act(async () => {
      resolve(outcome !== "cancel");
    });
    expect(fixture.sessions.size).toBe(2);
    expect(
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(other)]?.surfaces,
    ).toHaveLength(1);
  },
);

it("close all from a tool's menu closes only that group and never a terminal", async () => {
  const { original } = setup("all");
  const confirm = vi.fn(() => Promise.resolve(true));
  fixture.confirm = confirm;
  const store = useRightPanelStore.getState();
  store.openBrowser(original, null);
  store.openFile(original, "src/a.ts");
  store.openFile(original, "src/b.ts");
  const fileSurface = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    original,
  ).surfaces.find((surface) => surface.id === "file:src/a.ts")!;
  function CloseFiles() {
    const { closeAllSurfaces } = useRightPanelSurfaceClose({
      threadRef: original,
      terminalLabelsById: new Map(),
    });
    return <button onClick={() => closeAllSurfaces(fileSurface)}>Close all files</button>;
  }
  await using screen = await render(<CloseFiles />);
  await screen.getByRole("button").click();

  expect(confirm).not.toHaveBeenCalled();
  expect(fixture.sessions.size).toBe(2);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, original).surfaces.map(
      (surface) => surface.id,
    ),
  ).toEqual(["terminal:term-1", "browser:new"]);
});
