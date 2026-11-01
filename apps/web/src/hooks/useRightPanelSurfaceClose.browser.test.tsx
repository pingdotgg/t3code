import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const fixture = vi.hoisted(() => ({
  confirm: (_labels: readonly string[]): Promise<boolean> => Promise.resolve(false),
  allowed: new Set<string>(),
  sessions: new Map<string, string>(),
  failClose: false,
  sideChatShell: null as { latestRun: { runId: string } | null } | null,
  threadRemoved: false,
  failDelete: false,
  shellStatus: "live",
  clearedDrafts: [] as ScopedThreadRef[],
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
vi.mock("../state/session", () => ({
  useEnvironmentScope: (id: string) => fixture.allowed.has(id),
  readEnvironmentScope: (id: string) => fixture.allowed.has(id),
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => null,
  useProject: () => null,
  readThreadShell: () => fixture.sideChatShell,
  waitForThreadRemoval: async () => fixture.threadRemoved,
}));
vi.mock("../state/terminalSessions", () => ({ useKnownTerminalSessions: () => null }));
vi.mock("../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    useComposerDraftStore: Object.assign(() => null, {
      getState: () => ({
        clearDraftThread: (ref: ScopedThreadRef) => fixture.clearedDrafts.push(ref),
      }),
    }),
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
      if (label === "side chat delete" && fixture.failDelete) return { _tag: "Failure" };
      if (label === "terminal close" || label === "terminal write") fixture.sessions.delete(key);
      return { _tag: "Success" };
    },
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/terminal", () => ({ terminalEnvironment: { open: {}, close: {}, write: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { close: {} } }));
vi.mock("../state/threads", () => ({ threadEnvironment: { delete: {} } }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => ({ status: fixture.shellStatus }) },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
}));

function setup() {
  fixture.allowed = new Set(["environment-a", "environment-b"]);
  fixture.sessions = new Map();
  fixture.failClose = false;
  fixture.sideChatShell = null;
  fixture.threadRemoved = false;
  fixture.failDelete = false;
  fixture.shellStatus = "live";
  fixture.clearedDrafts = [];
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
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
    const { closeSurface } = useRightPanelSurfaceClose({
      threadRef,
      terminalLabelsById: new Map(),
    });
    return <button onClick={() => closeSurface(surface)}>Close original terminal</button>;
  }
  return { original, other, Harness, resolve };
}

it.each([false, true])(
  "keeps a pending close on its original environment and thread, fallback=%s",
  async (failClose) => {
    const { original, other, Harness, resolve } = setup();
    fixture.failClose = failClose;
    await using screen = await render(<Harness threadRef={original} />);
    await screen.getByRole("button").click();
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

it.each(["cancel", "revoked"])(
  "leaves both sessions intact when confirmation is %s",
  async (outcome) => {
    const { original, other, Harness, resolve } = setup();
    await using screen = await render(<Harness threadRef={original} />);
    await screen.getByRole("button").click();
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

// The local shell lags the server, so a run-less shell never proves the side chat was deleted.
it.each([
  { name: "the thread leaves the live shell", threadRemoved: true, cleared: true },
  { name: "the server keeps the thread", threadRemoved: false, cleared: false },
  { name: "the delete fails", threadRemoved: true, failDelete: true, cleared: false },
  { name: "the shell is not live", threadRemoved: true, shellStatus: "loading", cleared: false },
])(
  "clears a closed side chat's draft only after deletion: $name",
  async ({ threadRemoved, failDelete = false, shellStatus = "live", cleared }) => {
    const { original } = setup();
    fixture.sideChatShell = { latestRun: null };
    fixture.threadRemoved = threadRemoved;
    fixture.failDelete = failDelete;
    fixture.shellStatus = shellStatus;
    const sideChatId = ThreadId.make("side-chat-a");
    useRightPanelStore.getState().openSideChat(original, sideChatId);
    const surface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      original,
    ).surfaces.find((entry) => entry.kind === "side-chat")!;
    function SideChatHarness() {
      const { closeSurface } = useRightPanelSurfaceClose({
        threadRef: original,
        terminalLabelsById: new Map(),
      });
      return <button onClick={() => closeSurface(surface)}>Close side chat</button>;
    }
    await using screen = await render(<SideChatHarness />);
    await screen.getByRole("button").click();
    await act(async () => {});
    expect(fixture.clearedDrafts).toEqual(
      cleared ? [{ environmentId: original.environmentId, threadId: sideChatId }] : [],
    );
  },
);
