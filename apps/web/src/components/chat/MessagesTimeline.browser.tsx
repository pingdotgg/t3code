import "../../index.css";

import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));
const createAssetUrlMock = vi.hoisted(() =>
  vi.fn(async () => ({ relativeUrl: "/assets/signed/abc123" })),
);
const toastAddMock = vi.hoisted(() => vi.fn());

vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: toastAddMock },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => ({ assets: { createUrl: createAssetUrlMock } })),
  ensureEnvironmentApi: vi.fn(() => ({ assets: { createUrl: createAssetUrlMock } })),
}));

vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://localhost:3773"),
  getSavedEnvironmentRecord: vi.fn(() => null),
  getSavedEnvironmentRuntimeState: vi.fn(() => null),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: vi.fn(() => []),
  readSavedEnvironmentBearerToken: vi.fn(() => null),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
  resolveEnvironmentHttpUrl: vi.fn((_environmentId: unknown, path: string) => path),
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (selector: (state: object) => unknown) => selector({}),
  waitForSavedEnvironmentRegistryHydration: vi.fn(async () => undefined),
  addSavedEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  getPrimaryEnvironmentConnection: vi.fn(() => null),
  readEnvironmentConnection: vi.fn(() => null),
  reconnectSavedEnvironment: vi.fn(),
  setSavedEnvironmentEnabled: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(() => {
    throw new Error("environment unavailable");
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  startEnvironmentConnectionService: vi.fn(),
  subscribeEnvironmentConnections: vi.fn(() => () => undefined),
}));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    ref: React.ForwardedRef<LegendListRef>,
  ) {
    React.useImperativeHandle(
      ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          getState: getStateSpy,
        }) as unknown as LegendListRef,
    );

    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { terminalSessionManager } from "../../terminalSessionState";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    copilotResumeCommand: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    activeThreadId: ThreadId.make("thread-1"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

describe("MessagesTimeline", () => {
  it("opens only a live, owned terminal from a text-sized worklog shortcut without expanding details", async () => {
    const props = buildProps();
    const threadRef = scopeThreadRef(props.activeThreadEnvironmentId, props.activeThreadId);
    const terminalId = "agent-live-command";
    let metadata!: (event: TerminalMetadataStreamEvent) => void;
    const unsubscribe = terminalSessionManager.subscribeMetadata({
      environmentId: props.activeThreadEnvironmentId,
      client: {
        terminal: {
          onMetadata: (listener) => {
            metadata = listener;
            return () => {};
          },
        },
      },
    });
    const summary = {
      threadId: props.activeThreadId,
      terminalId,
      cwd: "/workspace",
      worktreePath: null,
      status: "running" as const,
      pid: 123,
      exitCode: null,
      exitSignal: null,
      hasRunningSubprocess: true,
      label: "pnpm dev",
      updatedAt: "2026-04-13T12:00:00.000Z",
    };
    const entry = (id: string, toolData: unknown): TimelineEntry => ({
      id,
      kind: "work",
      createdAt: summary.updatedAt,
      entry: {
        id,
        createdAt: summary.updatedAt,
        label: "terminal_start",
        tone: "tool",
        toolLifecycleStatus: "completed",
        isComplete: true,
        toolData,
      },
    });
    useTerminalStateStore.getState().removeTerminalState(threadRef);
    metadata({ type: "snapshot", terminals: [summary] });
    const screen = await render(
      <AppAtomRegistryProvider>
        <MessagesTimeline
          {...props}
          timelineEntries={[
            entry("live", {
              toolName: "mcp__t3-code__terminal_start",
              input: { command: "pnpm dev" },
              result: JSON.stringify({ terminalId }),
            }),
            entry("missing", {
              toolName: "terminal_read",
              rawInput: { terminalId: "agent-missing" },
            }),
            entry("unrelated", { toolName: "read_file", result: JSON.stringify({ terminalId }) }),
          ]}
        />
      </AppAtomRegistryProvider>,
    );
    try {
      await page.getByRole("button", { name: "Expand Tool Calls (3)" }).click();
      const shortcut = page.getByRole("button", {
        name: "Open running terminal: pnpm dev",
        exact: true,
      });
      await expect.element(shortcut).toBeVisible();
      expect(shortcut.elements()).toHaveLength(1);
      // Managed foreground commands can be the PTY root process, with no child subprocess.
      metadata({ type: "upsert", terminal: { ...summary, hasRunningSubprocess: false } });
      await expect.element(shortcut).toBeVisible();
      const icon = shortcut.element().querySelector("svg")!;
      expect(icon.getBoundingClientRect().width).toBeCloseTo(
        parseFloat(getComputedStyle(shortcut.element()).fontSize),
      );
      const state = () =>
        selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadKey,
          threadRef,
        );
      expect(state().terminalOpen).toBe(false);
      await shortcut.click();
      expect(state().terminalOpen).toBe(true);
      expect(state().activeTerminalId).toBe(terminalId);
      await expect
        .element(page.getByRole("button", { name: /^Collapse details:/ }))
        .not.toBeInTheDocument();
      for (const toolData of [
        {
          copilotToolName: "t3-code.terminal_start",
          rawOutput: { content: JSON.stringify({ terminalId }) },
        },
        { toolName: "terminal_start", rawOutput: { terminalId } },
        { toolName: "terminal_read", rawInput: { terminalId } },
      ]) {
        await screen.rerender(
          <AppAtomRegistryProvider>
            <MessagesTimeline {...props} timelineEntries={[entry("live", toolData)]} />
          </AppAtomRegistryProvider>,
        );
        await expect.element(shortcut).toBeVisible();
      }
      metadata({
        type: "upsert",
        terminal: { ...summary, status: "exited", hasRunningSubprocess: false },
      });
      await expect.element(shortcut).not.toBeInTheDocument();
      metadata({ type: "upsert", terminal: { ...summary, threadId: "other-thread" } });
      await expect.element(shortcut).not.toBeInTheDocument();
      metadata({ type: "snapshot", terminals: [summary] });
      await expect.element(shortcut).toBeVisible();
      terminalSessionManager.invalidateEnvironment(props.activeThreadEnvironmentId);
      await expect.element(shortcut).not.toBeInTheDocument();
      metadata({ type: "snapshot", terminals: [summary] });
      await expect.element(shortcut).toBeVisible();
      metadata({ type: "remove", threadId: summary.threadId, terminalId });
      await expect.element(shortcut).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      unsubscribe();
      terminalSessionManager.reset();
      useTerminalStateStore.getState().removeTerminalState(threadRef);
    }
  });
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--app-tool-font-size");
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Expand Work log (1)" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("visibly distinguishes messages sent from another thread", async () => {
    const text = "Please address these review findings.";
    const screen = await render(
      <AppAtomRegistryProvider>
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[
            {
              id: "cross-thread-message",
              kind: "message",
              createdAt: "2026-04-13T12:00:00.000Z",
              message: {
                id: MessageId.make("cross-thread-message"),
                role: "user",
                text,
                origin: {
                  kind: "cross-thread",
                  sourceThreadId: ThreadId.make("review-thread"),
                  sourceMessageId: MessageId.make("review-request"),
                  sourceThreadTitle: "Review thread",
                },
                createdAt: "2026-04-13T12:00:00.000Z",
                streaming: false,
              },
            },
          ]}
        />
      </AppAtomRegistryProvider>,
    );

    try {
      const message = page.getByText(text, { exact: true }).element().closest(".group");
      expect(message).not.toBeNull();
      expect(message!.classList.contains("bg-violet-500/15")).toBe(true);
      expect(message!.classList.contains("border-violet-400/45")).toBe(true);
      expect(getComputedStyle(message!).backgroundColor).toContain("/ 0.15)");
      await expect.element(page.getByText("Review thread", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByRole("button", { name: "Expand Work log (1)" })).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("renders the Copilot resume command beside terminal assistant metadata", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        copilotResumeCommand="copilot --resume=a7f0c803-7cce-4554-9ad6-dfd9df539e33"
        timelineEntries={[
          {
            id: "assistant-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: MessageId.make("assistant-message-1"),
              role: "assistant",
              text: "Done.",
              createdAt: "2026-04-22T19:00:45.000Z",
              completedAt: "2026-04-22T19:03:33.000Z",
              turnId: "turn-1" as never,
              streaming: false,
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("copilot --resume=a7f0c803-7cce-4554-9ad6-dfd9df539e33"))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders system messages supplied by workflow orchestration", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "workflow-1",
            kind: "message",
            createdAt: "2026-04-22T19:00:45.000Z",
            message: {
              id: MessageId.make("workflow-message-1"),
              role: "system",
              text: "Workflow started: repository review",
              createdAt: "2026-04-22T19:00:45.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Workflow started: repository review")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows live history and collapses it automatically when work completes", async () => {
    const turnId = TurnId.make("turn-activity");
    const props = buildProps();
    const createdAt = new Date().toISOString();
    const entries = ["a.ts", "b.ts", "live.ts", "parallel.ts"].map((name, index) => ({
      id: name,
      kind: "work" as const,
      createdAt,
      entry: {
        id: name,
        stableId: name,
        createdAt,
        turnId,
        tone: "tool" as const,
        label: "Read file",
        detail: `/workspace/src/${name}`,
        toolLifecycleStatus: index < 2 ? ("completed" as const) : ("inProgress" as const),
        isComplete: index < 2,
      },
    }));
    const screen = await render(
      <MessagesTimeline
        {...props}
        activeTurnId={turnId}
        activeTurnInProgress
        isWorking
        timelineEntries={entries}
      />,
    );
    await expect.element(page.getByText("Reading live.ts", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("+1", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: /^Expand details:/ }).elements()).toHaveLength(4);
    const trigger = page.getByRole("button", {
      name: "Collapse Tool Calls (4), 1 more active",
      exact: true,
    });
    const button = trigger.element();
    const group = button.closest(".work-group-section")!;
    expect(getComputedStyle(group).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(group).borderTopWidth).toBe("0px");
    expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(button.getBoundingClientRect().height).toBeLessThanOrEqual(44);
    expect(document.querySelectorAll(".work-activity-shimmer")).toHaveLength(1);
    await expect
      .element(
        page.getByRole("button", { name: "Collapse Tool Calls (4), 1 more active", exact: true }),
      )
      .toBeVisible();
    await expect.element(page.getByText(/4 actions.*2 active/)).toBeVisible();
    const panel = group.querySelector("[data-slot='collapsible-panel']")!;
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(getComputedStyle(panel).transitionDuration).toBe("0.12s");
    await page.getByRole("button", { name: "Expand details: Read a.ts" }).click();
    await expect.element(page.getByText("/workspace/src/a.ts", { exact: true })).toBeVisible();
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={entries.map((entry) => ({
          ...entry,
          entry: { ...entry.entry, toolLifecycleStatus: "completed", isComplete: true },
        }))}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Expand Tool Calls (4)" })).toBeVisible();
    expect(document.querySelectorAll(".work-activity-shimmer")).toHaveLength(0);
    await expect.element(page.getByText(/4 actions/)).not.toBeVisible();
    await page.getByRole("button", { name: "Expand Tool Calls (4)" }).click();
    await expect.element(page.getByText(/4 actions/)).toBeVisible();
    await screen.unmount();
  });

  it.each([10, 12, 16])(
    "uses a consistent %ipx work scale without clipping long filenames",
    async (fontSize) => {
      document.documentElement.style.setProperty("--app-tool-font-size", `${fontSize}px`);
      const turnId = TurnId.make("long-label-turn");
      const createdAt = new Date().toISOString();
      const filename =
        "durable-worktree-cleanup-reconciliation-and-workspace-reservation.integration.test.ts";
      const fullPath = `/workspace/src/${filename}`;
      const screen = await render(
        <div style={{ width: 320 }}>
          <MessagesTimeline
            {...buildProps()}
            activeTurnId={turnId}
            activeTurnInProgress
            isWorking
            activeTurnStartedAt={createdAt}
            timelineEntries={[
              {
                id: "long-edit",
                kind: "work",
                createdAt,
                entry: {
                  id: "long-edit",
                  createdAt,
                  turnId,
                  tone: "tool",
                  label: "Edit file",
                  detail: "/workspace/src/durable-worktree-c...",
                  changedFiles: ["/workspace/src/durable-worktree-c..."],
                  toolData: {
                    rawInput: `*** Begin Patch\n*** Update File: ${fullPath}\n@@\n-before\n+after\n*** End Patch`,
                    rawOutput: { content: `Modified 1 file(s): ${fullPath}` },
                  },
                  toolLifecycleStatus: "inProgress",
                  isComplete: false,
                },
              },
            ]}
          />
        </div>,
      );
      try {
        const header = page.getByRole("button", { name: "Collapse Tool Calls (1)", exact: true });
        await expect.element(header).toBeVisible();
        const working = document.querySelector(
          "[data-timeline-row-kind='working'] .chat-work-text",
        )!;
        expect(getComputedStyle(working).fontSize).toBe(`${fontSize}px`);
        expect(getComputedStyle(header.element()).fontSize).toBe(`${fontSize}px`);
        const label = header.element().querySelector(".chat-work-label")!;
        expect(label.textContent).toBe(`Editing ${filename}`);
        expect(getComputedStyle(label).textOverflow).not.toBe("ellipsis");
        expect(getComputedStyle(label).whiteSpace).toBe("normal");
        expect(header.element().getBoundingClientRect().width).toBeLessThanOrEqual(320);
        const detailButton = page.getByRole("button", {
          name: `Expand details: Editing ${filename}`,
          exact: true,
        });
        await expect.element(detailButton).toBeVisible();
        expect(getComputedStyle(detailButton.element()).fontSize).toBe(`${fontSize}px`);
        await detailButton.click();
        const detail = document.querySelector("[data-tool-command-details]")!;
        expect(detail.textContent).toContain(`Modified 1 file(s): ${fullPath}`);
        expect(detail.textContent).not.toContain("/workspace/src/durable-worktree-c...");
        expect(getComputedStyle(detail).fontSize).toBe(`${fontSize}px`);
        const details = detail.closest(".chat-work-details");
        expect(details).not.toBeNull();
        expect(getComputedStyle(details!).fontSize).toBe(`${fontSize}px`);
        expect(getComputedStyle(details!).getPropertyValue("text-size-adjust")).toBe("100%");
        expect(getComputedStyle(detail).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth + 1);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("shows specific command and read labels while truncating commands to chat width", async () => {
    const createdAt = new Date().toISOString();
    const command =
      "git status --short && git branch --show-current && git remote -v && git --no-pager log --oneline -5";
    const screen = await render(
      <div style={{ width: 320 }}>
        <MessagesTimeline
          {...buildProps()}
          activeTurnInProgress
          isWorking
          activeTurnStartedAt={createdAt}
          timelineEntries={[
            {
              id: "long-command",
              kind: "work",
              createdAt,
              entry: {
                id: "long-command",
                createdAt,
                tone: "tool",
                label: "Ran command",
                command,
                itemType: "command_execution",
                toolLifecycleStatus: "completed",
                isComplete: true,
              },
            },
            {
              id: "read-agents",
              kind: "work",
              createdAt,
              entry: {
                id: "read-agents",
                createdAt,
                tone: "tool",
                label: "Read file",
                toolData: {
                  toolName: "view",
                  rawInput: { path: "./.agents/skills/vercel-react-best-practices/AGENTS.md" },
                },
                toolLifecycleStatus: "completed",
                isComplete: true,
              },
            },
          ]}
        />
      </div>,
    );
    try {
      const commandButton = page.getByRole("button", {
        name: `Expand details: Ran ${command}`,
        exact: true,
      });
      await expect.element(commandButton).toBeVisible();
      const commandLabel = commandButton.element().querySelector(".chat-work-label")!;
      expect(commandLabel.textContent).toBe(`Ran ${command}`);
      expect(commandLabel.getAttribute("title")).toBe(`Ran ${command}`);
      expect(getComputedStyle(commandLabel).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(commandLabel).whiteSpace).toBe("nowrap");
      expect(commandButton.element().getBoundingClientRect().width).toBeLessThanOrEqual(320);
      await expect
        .element(page.getByRole("button", { name: "Expand details: Read AGENTS.md", exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens a short history directly without a duplicate summary disclosure", async () => {
    const createdAt = new Date().toISOString();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={["one.ts", "two.ts", "three.ts"].map((name) => ({
          id: name,
          kind: "work",
          createdAt,
          entry: {
            id: name,
            createdAt,
            tone: "tool",
            label: "Read file",
            detail: `/src/${name}`,
            toolLifecycleStatus: "completed",
            isComplete: true,
          },
        }))}
      />,
    );
    try {
      await page.getByRole("button", { name: "Expand Tool Calls (3)", exact: true }).click();
      expect(page.getByRole("button", { name: /^Expand details:/ }).elements()).toHaveLength(3);
      await expect
        .element(page.getByRole("button", { name: "Read 3 files", exact: true }))
        .not.toBeInTheDocument();
      const rows = page.getByRole("button", { name: /^Expand details:/ }).elements();
      for (const row of rows) {
        expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(26);
        const label = row.querySelector(".chat-work-label")!;
        const chevron = row.querySelector("svg:last-child")!;
        expect(
          chevron.getBoundingClientRect().left - label.getBoundingClientRect().right,
        ).toBeLessThanOrEqual(8);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("does not render provider tool-call IDs as expanded tool evidence", async () => {
    const toolCallId = `call_${"synthetic-tool-id-".repeat(20)}`;
    const turnId = TurnId.make("tool-evidence-turn");
    const createdAt = new Date().toISOString();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeTurnId={turnId}
        activeTurnInProgress
        isWorking
        activeTurnStartedAt={createdAt}
        timelineEntries={[
          {
            id: "tool-1",
            kind: "work",
            createdAt,
            entry: {
              id: "tool-1",
              createdAt,
              turnId,
              sourceActivityKind: "tool.completed",
              tone: "tool",
              label: "Ran web_search",
              toolData: { toolCallId },
              toolLifecycleStatus: "completed",
              isComplete: true,
            },
          },
        ]}
      />,
    );

    try {
      await page.getByRole("button", { name: /Expand details/ }).click();
      await expect
        .element(page.getByRole("button", { name: "Load full tool evidence" }))
        .toBeVisible();
      expect(document.querySelector(".chat-work-details")?.textContent ?? "").not.toContain(
        toolCallId,
      );
    } finally {
      await screen.unmount();
    }
  });

  it.each([125, 5_000])(
    "bounds a %i-action history group to 50 rows per disclosure batch",
    async (count) => {
      const createdAt = new Date().toISOString();
      const screen = await render(
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={Array.from({ length: count }, (_, index) => ({
            id: `read-${index}`,
            kind: "work",
            createdAt,
            entry: {
              id: `read-${index}`,
              createdAt,
              tone: "tool",
              label: "Read file",
              detail: `/src/file-${index}.ts`,
              toolLifecycleStatus: "completed",
              isComplete: true,
            },
          }))}
        />,
      );
      try {
        await page
          .getByRole("button", { name: `Expand Tool Calls (${count})`, exact: true })
          .click();
        expect(
          page.getByRole("button", { name: /^Expand details: Read file-/ }).elements(),
        ).toHaveLength(50);
        await page
          .getByRole("button", {
            name: `Show 50 earlier actions (${count - 50} remaining)`,
            exact: true,
          })
          .click();
        expect(
          page.getByRole("button", { name: /^(Expand|Collapse) details: Read file-/ }).elements(),
        ).toHaveLength(100);
        await page
          .getByRole("button", { name: `Expand details: Read file-${count - 1}.ts`, exact: true })
          .click();
        await expect
          .element(page.getByText(`/src/file-${count - 1}.ts`, { exact: true }))
          .toBeVisible();
        expect(
          page.getByRole("button", { name: /^(Expand|Collapse) details: Read file-/ }).elements(),
        ).toHaveLength(100);
        if (count === 125) {
          await page.getByRole("button", { name: "Show 25 earlier actions", exact: true }).click();
          expect(
            page.getByRole("button", { name: /^(Expand|Collapse) details: Read file-/ }).elements(),
          ).toHaveLength(125);
          await expect
            .element(page.getByRole("button", { name: /earlier actions/ }))
            .not.toBeInTheDocument();
        }
      } finally {
        await screen.unmount();
      }
    },
  );

  it("shows mixed work directly without nested category disclosures", async () => {
    const createdAt = new Date().toISOString();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={Array.from({ length: 13 }, (_, index) => ({
          id: `mixed-${index}`,
          kind: "work",
          createdAt,
          entry: {
            id: `mixed-${index}`,
            createdAt,
            tone: "tool",
            label: index % 2 === 0 ? "Read file" : "Ran command",
            detail: `/src/mixed-${index}.ts`,
            ...(index % 2 === 1 ? { command: "pnpm test" } : {}),
            toolLifecycleStatus: "completed",
            isComplete: true,
          },
        }))}
      />,
    );
    try {
      await page.getByRole("button", { name: "Expand Tool Calls (13)", exact: true }).click();
      expect(page.getByRole("button", { name: /^Expand details:/ }).elements()).toHaveLength(13);
      await expect
        .element(page.getByRole("button", { name: /earlier group/ }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each([1, 3])(
    "consolidates %i calls into Worked for and auto-collapses at the response boundary",
    async (count) => {
      const props = buildProps();
      const turnId = TurnId.make("phase-turn");
      const user = {
        id: "phase-user",
        kind: "message" as const,
        createdAt: "2026-09-08T10:00:00.000Z",
        message: {
          id: MessageId.make("phase-user"),
          role: "user" as const,
          text: "Inspect the work log",
          createdAt: "2026-09-08T10:00:00.000Z",
          streaming: false,
        },
      };
      const work = Array.from({ length: count }, (_, index) => ({
        id: `phase-work-${index}`,
        kind: "work" as const,
        createdAt: "2026-09-08T10:00:01.000Z",
        entry: {
          id: `phase-work-${index}`,
          createdAt: "2026-09-08T10:00:01.000Z",
          turnId,
          label: "other",
          toolTitle: "other",
          tone: "tool" as const,
          toolLifecycleStatus: "completed" as const,
          toolData: {
            toolName: "skill",
            rawInput: { skill: `skill-${index}` },
            rawOutput: { content: `Loaded full skill ${index}` },
          },
        },
      }));
      const response = {
        id: "phase-response",
        kind: "message" as const,
        createdAt: "2026-09-08T10:00:10.000Z",
        message: {
          id: MessageId.make("phase-response"),
          role: "assistant" as const,
          turnId,
          text: "Here is what I found.",
          createdAt: "2026-09-08T10:00:10.000Z",
          streaming: true,
        },
      };
      const activeProps = {
        ...props,
        isWorking: true,
        activeTurnInProgress: true,
        activeTurnId: turnId,
      };
      const screen = await render(
        <MessagesTimeline {...activeProps} timelineEntries={[user, ...work]} />,
      );
      try {
        const close = page.getByRole("button", {
          name: `Collapse Tool Calls (${count})`,
          exact: true,
        });
        await expect.element(close).toBeVisible();
        expect(
          page.getByRole("button", { name: /^Expand details: Loaded skill-/ }).elements(),
        ).toHaveLength(count);
        await expect.element(page.getByText("other", { exact: true })).not.toBeInTheDocument();
        await close.click();
        await screen.rerender(
          <MessagesTimeline {...activeProps} timelineEntries={[user, ...work]} />,
        );
        await expect
          .element(page.getByRole("button", { name: `Expand Tool Calls (${count})` }))
          .toBeVisible();
        await page.getByRole("button", { name: `Expand Tool Calls (${count})` }).click();
        await screen.rerender(
          <MessagesTimeline {...activeProps} timelineEntries={[user, ...work, response]} />,
        );
        await expect
          .element(page.getByRole("button", { name: `Expand Tool Calls (${count})` }))
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: /^Expand details: Loaded skill-/ }).first())
          .not.toBeInTheDocument();
        await page.getByRole("button", { name: `Expand Tool Calls (${count})` }).click();
        await expect
          .element(
            page.getByRole("button", { name: "Expand details: Loaded skill-0", exact: true }),
          )
          .toBeVisible();
        await screen.rerender(
          <MessagesTimeline
            {...props}
            timelineEntries={[
              user,
              ...work,
              {
                ...response,
                message: {
                  ...response.message,
                  streaming: false,
                  completedAt: "2026-09-08T10:00:12.000Z",
                },
              },
            ]}
          />,
        );
        const receipt = page.getByRole("button", { name: /^Worked for/ });
        await expect.element(receipt).toHaveAttribute("aria-expanded", "false");
        await expect
          .element(page.getByRole("button", { name: /Tool Calls/ }))
          .not.toBeInTheDocument();
        await receipt.click();
        expect(
          page.getByRole("button", { name: /^Expand details: Loaded skill-/ }).elements(),
        ).toHaveLength(count);
        await page
          .getByRole("button", { name: "Expand details: Loaded skill-0", exact: true })
          .click();
        await expect.element(page.getByText("Loaded full skill 0", { exact: true })).toBeVisible();
        await receipt.click();
        await expect
          .element(page.getByText("Loaded full skill 0", { exact: true }))
          .not.toBeVisible();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("bounds consolidated history across multiple work phases to 50 entries", async () => {
    const createdAt = "2026-09-08T10:00:00.000Z";
    const turnId = TurnId.make("bounded-receipt");
    const timelineEntries: TimelineEntry[] = [
      {
        id: "bounded-user",
        kind: "message",
        createdAt,
        message: {
          id: MessageId.make("bounded-user"),
          role: "user",
          text: "Inspect the repository",
          createdAt,
          streaming: false,
        },
      },
    ];
    for (let index = 0; index < 120; index += 1) {
      timelineEntries.push({
        id: `bounded-${index}`,
        kind: "work",
        createdAt,
        entry: {
          id: `bounded-${index}`,
          turnId,
          label: "Read file",
          detail: `/src/file-${index}.ts`,
          tone: "tool",
          createdAt,
          toolLifecycleStatus: "completed",
        },
      });
      if (index === 39 || index === 79) {
        timelineEntries.push({
          id: `progress-${index}`,
          kind: "message",
          createdAt,
          message: {
            id: MessageId.make(`progress-${index}`),
            role: "assistant",
            turnId,
            text: `Inspected ${index + 1} files.`,
            createdAt,
            streaming: false,
          },
        });
      }
    }
    timelineEntries.push({
      id: "bounded-response",
      kind: "message",
      createdAt,
      message: {
        id: MessageId.make("bounded-response"),
        role: "assistant",
        turnId,
        text: "Finished.",
        createdAt,
        completedAt: "2026-09-08T10:00:10.000Z",
        streaming: false,
      },
    });
    const screen = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
    );
    try {
      const receipt = page.getByRole("button", { name: /^Worked for/ });
      await receipt.click();
      const history = receipt
        .element()
        .closest(".work-group-section")!
        .querySelector(".chat-work-panel-body > div")!;
      expect(history.children).toHaveLength(51);
      expect(page.getByRole("button", { name: /^Expand details:/ }).elements()).toHaveLength(49);
      await page.getByRole("button", { name: "Show 50 earlier entries (72 remaining)" }).click();
      expect(history.children).toHaveLength(101);
      await page.getByRole("button", { name: "Show 22 earlier entries" }).click();
      expect(history.children).toHaveLength(122);
      expect(page.getByRole("button", { name: /^Expand details:/ }).elements()).toHaveLength(120);
      await expect
        .element(page.getByRole("button", { name: /Tool Calls/ }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each([false, true])(
    "folds repeated calls without hiding their output (settled: %s)",
    async (settled) => {
      const createdAt = "2026-09-08T10:00:00.000Z";
      const turnId = TurnId.make(`repeat-${settled}`);
      const work: TimelineEntry[] = Array.from({ length: 3 }, (_, index) => ({
        id: `repeat-${index}`,
        kind: "work",
        createdAt,
        entry: {
          id: `repeat-${index}`,
          turnId,
          createdAt,
          label: "Edited files",
          tone: "tool",
          itemType: "file_change",
          toolLifecycleStatus: "completed",
          detail: "Edit applied successfully.",
          toolData: {
            rawInput: { path: "/src/file.ts" },
            rawOutput: { content: `Result ${index}` },
          },
        },
      }));
      const entries: TimelineEntry[] = settled
        ? [
            {
              id: "repeat-user",
              kind: "message",
              createdAt,
              message: {
                id: MessageId.make("repeat-user"),
                role: "user",
                text: "Edit the file",
                createdAt,
                streaming: false,
              },
            },
            ...work,
            {
              id: "repeat-response",
              kind: "message",
              createdAt,
              message: {
                id: MessageId.make("repeat-response"),
                role: "assistant",
                turnId,
                text: "Done",
                createdAt,
                completedAt: createdAt,
                streaming: false,
              },
            },
          ]
        : [
            ...work,
            {
              id: "active-repeat",
              kind: "work",
              createdAt,
              entry: {
                id: "active-repeat",
                turnId,
                createdAt,
                label: "Edited files",
                tone: "tool",
                itemType: "file_change",
                toolLifecycleStatus: "inProgress",
                detail: "/src/file.ts",
              },
            },
          ];
      const screen = await render(
        <MessagesTimeline
          {...buildProps()}
          activeTurnId={turnId}
          isWorking={!settled}
          activeTurnInProgress={!settled}
          timelineEntries={entries}
        />,
      );
      try {
        if (settled) await page.getByRole("button", { name: /^Worked/ }).click();
        const repeat = page.getByRole("button", {
          name: "Expand 3 calls: Edited file.ts",
          exact: true,
        });
        await expect.element(repeat).toBeVisible();
        expect(
          page
            .getByRole("button", { name: "Expand details: Edited file.ts", exact: true })
            .elements(),
        ).toHaveLength(0);
        if (!settled)
          await expect
            .element(
              page.getByRole("button", { name: "Expand details: Editing file.ts", exact: true }),
            )
            .toBeVisible();
        await repeat.click();
        const calls = page.getByRole("button", {
          name: "Expand details: Edited file.ts",
          exact: true,
        });
        expect(calls.elements()).toHaveLength(3);
        for (let index = 0; index < 3; index += 1) {
          await calls.first().click();
          await expect.element(page.getByText(`Result ${index}`, { exact: true })).toBeVisible();
        }
        const workDetails = document.querySelectorAll("[data-tool-command-details]");
        expect(workDetails).toHaveLength(3);
        for (const detail of workDetails) {
          expect(detail.parentElement?.querySelector("button")).toBeNull();
        }
        await page
          .getByRole("button", { name: "Collapse 3 calls: Edited file.ts", exact: true })
          .click();
        await expect.element(page.getByText("Result 0", { exact: true })).not.toBeVisible();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps failures visible in a collapsed receipt after later successful work", async () => {
    const createdAt = new Date().toISOString();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "failed",
            kind: "work",
            createdAt,
            entry: {
              id: "failed",
              createdAt,
              tone: "tool",
              label: "Ran command",
              command: "pnpm test",
              toolLifecycleStatus: "failed",
              isComplete: true,
            },
          },
          {
            id: "success",
            kind: "work",
            createdAt,
            entry: {
              id: "success",
              createdAt,
              tone: "tool",
              label: "Read file",
              detail: "/src/file.ts",
              toolLifecycleStatus: "completed",
              isComplete: true,
            },
          },
        ]}
      />,
    );
    await expect.element(page.getByText("Failed pnpm test", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Expand Tool Calls (2)" })).toBeVisible();
    expect(document.querySelector(".work-activity-shimmer")).toBeNull();
    await screen.unmount();
  });

  it("keeps the previous Worked for receipt collapsed when a new turn starts without a server turn id yet", async () => {
    const props = buildProps();
    const turnId = TurnId.make("turn-1");
    const base = [
      {
        id: "user-1",
        kind: "message",
        createdAt: "2026-09-08T10:00:00.000Z",
        message: {
          id: MessageId.make("user-1"),
          role: "user",
          text: "first",
          createdAt: "2026-09-08T10:00:00.000Z",
          streaming: false,
        },
      },
      {
        id: "work-1",
        kind: "work",
        createdAt: "2026-09-08T10:00:01.000Z",
        entry: {
          id: "work-1",
          createdAt: "2026-09-08T10:00:01.000Z",
          turnId,
          label: "Read file",
          detail: "/src/a.ts",
          tone: "tool",
          toolLifecycleStatus: "completed",
          isComplete: true,
        },
      },
      {
        id: "asst-1",
        kind: "message",
        createdAt: "2026-09-08T10:00:10.000Z",
        message: {
          id: MessageId.make("asst-1"),
          role: "assistant",
          turnId,
          text: "done",
          createdAt: "2026-09-08T10:00:10.000Z",
          completedAt: "2026-09-08T10:00:12.000Z",
          streaming: false,
        },
      },
    ] as unknown as TimelineEntry[];

    const screen = await render(<MessagesTimeline {...props} timelineEntries={base} />);
    try {
      const receipt = page.getByRole("button", { name: /^Worked for/ });
      await expect.element(receipt).toBeVisible();
      await expect.element(receipt).toHaveAttribute("aria-expanded", "false");

      // Optimistic send: working indicator is up but the server has not acked
      // the new turn, so callers pass a null activeTurnId. The previous
      // receipt must stay collapsed instead of uncollapsing into Tool Calls.
      const withNewUser = [
        ...base,
        {
          id: "user-2",
          kind: "message",
          createdAt: "2026-09-08T10:01:00.000Z",
          message: {
            id: MessageId.make("user-2"),
            role: "user",
            text: "second",
            createdAt: "2026-09-08T10:01:00.000Z",
            streaming: false,
          },
        },
      ] as unknown as TimelineEntry[];
      await screen.rerender(
        <MessagesTimeline
          {...props}
          isWorking
          activeTurnInProgress
          activeTurnId={null}
          activeTurnStartedAt={new Date().toISOString()}
          timelineEntries={withNewUser}
        />,
      );
      await expect.element(receipt).toHaveAttribute("aria-expanded", "false");
      await expect
        .element(page.getByRole("button", { name: "Expand Tool Calls (1)", exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("opens message attachments staged outside the workspace", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "user-1",
            kind: "message",
            createdAt: "2026-09-08T10:00:00.000Z",
            message: {
              id: MessageId.make("user-message-1"),
              role: "user",
              text: "Look at this",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-abc123",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 42,
                },
              ],
              createdAt: "2026-09-08T10:00:00.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );
    try {
      await page.getByRole("button", { name: "Open shot.png" }).click();
      await vi.waitFor(() => {
        expect(createAssetUrlMock).toHaveBeenCalledWith({
          resource: {
            _tag: "attachment",
            attachmentId: "thread-1-abc123",
            fileName: "shot.png",
            mimeType: "image/png",
            disposition: "inline",
          },
        });
      });
      expect(props.onImageExpand).toHaveBeenCalledWith({
        images: [{ src: "http://localhost:3773/assets/signed/abc123", name: "shot.png" }],
        index: 0,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("reports the real error when the clicked attachment fails to load", async () => {
    createAssetUrlMock.mockRejectedValueOnce(new Error("boom"));
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "user-1",
            kind: "message",
            createdAt: "2026-09-08T10:00:00.000Z",
            message: {
              id: MessageId.make("user-message-1"),
              role: "user",
              text: "Look at this",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-abc123",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 42,
                },
              ],
              createdAt: "2026-09-08T10:00:00.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );
    try {
      await page.getByRole("button", { name: "Open shot.png" }).click();
      await vi.waitFor(() => {
        expect(toastAddMock).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Unable to open attachment",
            description: "boom",
          }),
        );
      });
      expect(props.onImageExpand).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
