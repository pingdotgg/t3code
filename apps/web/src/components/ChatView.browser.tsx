import "../index.css";

import { type MessageId, type ThreadId } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, Thread } from "../types";
import ChatView from "./ChatView";
import { estimateTimelineMessageHeight } from "./timelineHeight";

const mocks = vi.hoisted(() => {
  return {
    navigate: vi.fn(),
    markThreadVisited: vi.fn(),
    setThreadError: vi.fn(),
    setRuntimeMode: vi.fn(),
    setThreadBranch: vi.fn(),
    storeState: {
      projects: [] as unknown[],
      threads: [] as Thread[],
      runtimeMode: "full-access",
      markThreadVisited: vi.fn(),
      setError: vi.fn(),
      setRuntimeMode: vi.fn(),
      setThreadBranch: vi.fn(),
    },
    composerDraft: {
      prompt: "",
      images: [] as unknown[],
      nonPersistedImageIds: [] as string[],
      model: null,
      effort: null,
    },
    composerStore: {
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      setPrompt: vi.fn(),
      setModel: vi.fn(),
      setEffort: vi.fn(),
      addImage: vi.fn(),
      addImages: vi.fn(),
      removeImage: vi.fn(),
      clearPersistedAttachments: vi.fn(),
      syncPersistedAttachments: vi.fn(),
      clearComposerContent: vi.fn(),
      clearDraftThread: vi.fn(),
      setDraftThreadContext: vi.fn(),
    },
    terminalStore: {
      terminalStateByThreadId: {} as Record<string, unknown>,
      setTerminalOpen: vi.fn(),
      setTerminalHeight: vi.fn(),
      splitTerminal: vi.fn(),
      newTerminal: vi.fn(),
      setActiveTerminal: vi.fn(),
      closeTerminal: vi.fn(),
    },
    terminalState: {
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useSearch: (options?: { select?: (params: Record<string, unknown>) => unknown }) =>
    options?.select ? options.select({}) : {},
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQueryClient: () => ({}),
    useMutation: () => ({
      mutateAsync: vi.fn(async () => ({})),
      isPending: false,
    }),
    useQuery: () => ({
      data: undefined,
      isLoading: false,
      error: null,
    }),
  };
});

vi.mock("../store", () => ({
  useStore: (selector: (store: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerThreadDraft: () => mocks.composerDraft,
  useComposerDraftStore: (selector: (store: typeof mocks.composerStore) => unknown) =>
    selector(mocks.composerStore),
}));

vi.mock("../terminalStateStore", () => ({
  useTerminalStateStore: (selector: (store: typeof mocks.terminalStore) => unknown) =>
    selector(mocks.terminalStore),
  selectThreadTerminalState: () => mocks.terminalState,
}));

vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: [],
    inferredCheckpointTurnCountByTurnId: {},
  }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" as const }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
  ensureNativeApi: () => {
    throw new Error("Native API unavailable in browser test");
  },
}));

vi.mock("./BranchToolbar", () => ({
  default: () => null,
}));

vi.mock("./GitActionsControl", () => ({
  default: () => null,
}));

vi.mock("./ProjectScriptsControl", () => ({
  default: () => null,
}));

vi.mock("./ThreadTerminalDrawer", () => ({
  default: () => null,
}));

vi.mock("./ComposerPromptEditor", () => ({
  ComposerPromptEditor: () => null,
}));

vi.mock("./ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

const THREAD_ID = "thread-browser-test" as ThreadId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const TALL_IMAGE_DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>",
)}`;

interface RenderMeasureOptions {
  timelineWidthPx: number;
  messages: ChatMessage[];
  targetMessageId: MessageId;
}

function createThread(messages: ChatMessage[]): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    title: "Browser test thread",
    model: "gpt-5",
    session: null,
    messages,
    error: null,
    createdAt: NOW_ISO,
    latestTurn: null,
    lastVisitedAt: NOW_ISO,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createUserMessage({
  id,
  text,
  offsetSeconds,
  attachments,
}: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: ChatMessage["attachments"];
}): ChatMessage {
  return {
    id,
    role: "user",
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    createdAt: isoAt(offsetSeconds),
    completedAt: isoAt(offsetSeconds + 1),
    streaming: false,
  };
}

function createAssistantMessage({
  id,
  text,
  offsetSeconds,
}: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
}): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    createdAt: isoAt(offsetSeconds),
    completedAt: isoAt(offsetSeconds + 1),
    streaming: false,
  };
}

function createImageAttachments(count: number): NonNullable<ChatMessage["attachments"]> {
  return Array.from({ length: count }, (_, index) => ({
    type: "image" as const,
    id: `attachment-${index + 1}`,
    name: `attachment-${index + 1}.svg`,
    mimeType: "image/svg+xml",
    sizeBytes: 128,
    previewUrl: TALL_IMAGE_DATA_URI,
  }));
}

function createConversationWithTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachments?: ChatMessage["attachments"];
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < 22; index += 1) {
    const userId = (`msg-user-${index}` as MessageId);
    const assistantId = (`msg-assistant-${index}` as MessageId);
    const isTarget = index === 3;
    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        attachments: isTarget ? options.targetAttachments : undefined,
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }
  return messages;
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function renderAndMeasureUserRow({
  timelineWidthPx,
  messages,
  targetMessageId,
}: RenderMeasureOptions): Promise<{
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
}> {
  const host = document.createElement("div");
  host.style.width = `${timelineWidthPx}px`;
  host.style.height = "920px";
  host.style.display = "flex";
  host.style.overflow = "hidden";
  document.body.append(host);

  mocks.storeState.threads = [createThread(messages)];

  const root: Root = createRoot(host);
  root.render(<ChatView threadId={THREAD_ID} />);
  await waitForLayout();

  const scrollContainer = host.querySelector("div.overflow-y-auto.overscroll-y-contain");
  if (!(scrollContainer instanceof HTMLDivElement)) {
    root.unmount();
    throw new Error("Unable to find ChatView message scroll container.");
  }
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await waitForLayout();

  const row = host.querySelector<HTMLElement>(
    `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
  );
  if (!(row instanceof HTMLElement)) {
    root.unmount();
    throw new Error("Unable to locate targeted user message row.");
  }
  await waitForImagesToLoad(row);

  const timelineRoot = row.closest("div.max-w-3xl");
  if (!(timelineRoot instanceof HTMLElement)) {
    root.unmount();
    throw new Error("Unable to locate timeline root container.");
  }

  const measuredRowHeightPx = row.getBoundingClientRect().height;
  const timelineWidthMeasuredPx = timelineRoot.getBoundingClientRect().width;
  const renderedInVirtualizedRegion = row.closest("[data-index]") instanceof HTMLElement;

  root.unmount();
  host.remove();

  return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
}

describe("ChatView timeline estimator parity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.storeState.projects = [];
    mocks.storeState.threads = [];
    mocks.storeState.runtimeMode = "full-access";
    mocks.composerDraft.prompt = "";
    mocks.composerDraft.images = [];
    mocks.composerDraft.nonPersistedImageIds = [];
    mocks.composerDraft.model = null;
    mocks.composerDraft.effort = null;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps long user message estimate close to actual rendered virtualized ChatView row height", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-long" as MessageId;
    const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
      await renderAndMeasureUserRow({
        timelineWidthPx: 960,
        targetMessageId,
        messages: createConversationWithTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

    expect(renderedInVirtualizedRegion).toBe(true);

    const estimatedHeightPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: timelineWidthMeasuredPx },
    );

    expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(44);
  });

  it("tracks additional rendered wrapping when ChatView width narrows", async () => {
    const userText = "x".repeat(2_400);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const messages = createConversationWithTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktop = await renderAndMeasureUserRow({
      timelineWidthPx: 960,
      targetMessageId,
      messages,
    });
    const mobile = await renderAndMeasureUserRow({
      timelineWidthPx: 360,
      targetMessageId,
      messages,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktop.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobile.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx = mobile.measuredRowHeightPx - desktop.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it("keeps user attachment estimate close to actual rendered ChatView row height", async () => {
    const targetMessageId = "msg-user-target-attachments" as MessageId;
    const attachments = createImageAttachments(3);
    const userText = "message with image attachments";
    const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
      await renderAndMeasureUserRow({
        timelineWidthPx: 960,
        targetMessageId,
        messages: createConversationWithTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachments: attachments,
        }),
      });

    expect(renderedInVirtualizedRegion).toBe(true);

    const estimatedHeightPx = estimateTimelineMessageHeight(
      {
        role: "user",
        text: userText,
        attachments: attachments.map((attachment) => ({ id: attachment.id })),
      },
      { timelineWidthPx: timelineWidthMeasuredPx },
    );

    expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(56);
  });
});
