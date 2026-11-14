import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProjectScript,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useChatTerminalActions } from "./useChatTerminalActions";

interface TerminalRequest {
  readonly environmentId: string;
  readonly input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly data?: string;
  };
}

const fixture = vi.hoisted(() => ({
  allowed: new Set<string>(),
  opens: [] as Array<{ request: TerminalRequest; finish: () => void }>,
  writes: [] as Array<TerminalRequest>,
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: (id: string) => fixture.allowed.has(id),
}));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useQuietThreadShell: (ref: ScopedThreadRef | null) =>
    ref && { environmentId: ref.environmentId, projectId: "project", worktreePath: null },
  useProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../../state/terminalSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/terminalSessions")>()),
  useKnownTerminalSessions: () => [],
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (_command: unknown, label: unknown) => (request: TerminalRequest) => {
    if (label === "terminal open") {
      return new Promise((resolve) => {
        fixture.opens.push({ request, finish: () => resolve({ _tag: "Success" }) });
      });
    }
    if (label === "terminal write") fixture.writes.push(request);
    return Promise.resolve({ _tag: "Success" });
  },
}));

const script: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "npm run dev",
  icon: "play",
  runOnWorktreeCreate: false,
};
const first: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

function Harness({ threadRef }: { threadRef: ScopedThreadRef }) {
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const { runProjectScriptStable } = useChatTerminalActions({
    environmentId: threadRef.environmentId,
    composerRef: { current: null },
    terminalUiState,
    activeThread: { worktreePath: null },
    activeThreadId: threadRef.threadId,
    activeThreadRef: threadRef,
    activeProject: { id: ProjectId.make("project"), workspaceRoot: "/project" },
    activeRightPanelSurface: null,
    runningTerminalIds: [],
    activeServerOrderedTerminalIds: [],
    activeTerminalLabelsById: new Map(),
    panelTerminalIds: new Set(),
    canReuseTerminal: true,
    gitCwd: "/project",
    setTerminalUiLaunchContext: () => {},
    setThreadError: () => {},
  });
  return <button onClick={() => void runProjectScriptStable(script)}>Run Dev</button>;
}

/** Starts the script on `first`, then moves to `next` while its terminal is still opening. */
async function launchThenNavigate(next: ScopedThreadRef) {
  fixture.allowed = new Set(["environment-a", "environment-b"]);
  fixture.opens = [];
  fixture.writes = [];
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(<Harness threadRef={first} />));
  await screen.getByRole("button", { name: "Run Dev" }).click();
  await screen.rerender(<Harness threadRef={next} />);
  const [open] = fixture.opens;
  if (!open) throw new Error("the script did not open a terminal");
  return { mounted: stack.move(), open };
}

it.each([
  { name: "the same thread", next: first },
  {
    name: "another environment",
    next: { environmentId: EnvironmentId.make("environment-b"), threadId: ThreadId.make("b") },
  },
])("types the command into the terminal it opened after moving to $name", async ({ next }) => {
  const { mounted, open } = await launchThenNavigate(next);
  await using _mounted = mounted;
  await act(async () => open.finish());
  expect(fixture.writes).toEqual([
    {
      environmentId: "environment-a",
      input: {
        threadId: "thread-a",
        terminalId: open.request.input.terminalId,
        data: " npm run dev\r",
      },
    },
  ]);
});

it("types nothing once the launching environment loses terminal access", async () => {
  const { mounted, open } = await launchThenNavigate({
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("b"),
  });
  await using _mounted = mounted;
  fixture.allowed.delete("environment-a");
  await act(async () => open.finish());
  expect(fixture.writes).toEqual([]);
});
