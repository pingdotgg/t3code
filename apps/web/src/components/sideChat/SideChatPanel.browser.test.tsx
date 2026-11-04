import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  type AssistantCitation,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2SideChat,
  type OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { createModelSelection } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<{ readonly id: string }>,
  projections: {} as Record<string, unknown>,
  visibleTurnItems: [] as ReadonlyArray<unknown>,
  /** Keyed by `${threadId}:${messageId}`. */
  marks: {} as Record<string, ReadonlyArray<unknown>>,
  noMarks: [] as ReadonlyArray<unknown>,
  canOperate: true,
  dispatch: (async () => undefined) as (...args: never) => Promise<unknown>,
  /** Each citation activation the panel's timeline asked to reveal, by its key. */
  citedHistoryRequests: [] as Array<{ key: string; threadId: string; messageId: string }>,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSideChatTreeShells: (() => state.shells) as never,
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null
      ? null
      : (state.shells.find((shell) => shell.id === ref.threadId) ?? null)) as never,
  useQuietThreadProjection: ((ref: { threadId: string } | null) =>
    ref === null ? null : (state.projections[ref.threadId] ?? null)) as never,
  useThreadProjection: ((ref: { threadId: string } | null) =>
    ref === null ? null : (state.projections[ref.threadId] ?? null)) as never,
  useSideChatNoteDelivered: ((
    parentRef: { threadId: string } | null,
    sideChatId: string,
    requestId: string,
  ) => {
    const parent =
      parentRef === null
        ? undefined
        : (state.projections[parentRef.threadId] as EnvironmentThreadStructure | undefined);
    return parent === undefined
      ? null
      : parent.projection.thread.sideChatNoteDeliveries?.[ThreadId.make(sideChatId)] === requestId;
  }) as never,
  useTimelineVisibleTurnItems: (() => state.visibleTurnItems) as never,
  useSideChatMarks: ((ref: { threadId: string } | null, messageId: string) =>
    ref === null
      ? state.noMarks
      : (state.marks[`${ref.threadId}:${messageId}`] ?? state.noMarks)) as never,
}));

// The real procedure pages the cited thread's history from a server the test does not serve.
vi.mock(import("../chat/citationProcedure"), async (importOriginal) => ({
  ...(await importOriginal()),
  useCitedHistory: ((
    request: { key: string; citation: { threadId: string; messageId: string } } | null,
  ) => {
    if (request !== null && !state.citedHistoryRequests.some((seen) => seen.key === request.key)) {
      const { threadId, messageId } = request.citation;
      state.citedHistoryRequests.push({ key: request.key, threadId, messageId });
    }
    return { _tag: "loading" };
  }) as never,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => state.dispatch) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => state.canOperate,
  useEnvironmentScope: () => state.canOperate,
}));

// The real settings and keybindings watch environment connections the test does not serve.
vi.mock(import("../../state/server"), async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const { mergeWithDefaultKeybindings } = await import("@t3tools/shared/keybindings");
  return {
    ...(await importOriginal()),
    primaryServerKeybindingsAtom: Atom.make(mergeWithDefaultKeybindings([])),
  };
});
vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentSettings: ((
    _environmentId: EnvironmentId,
    selector: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown,
  ) => selector({ ...DEFAULT_UNIFIED_SETTINGS, sendShortcut: "enter" })) as never,
}));

import { act, render, type Screen } from "../../../test/render";
import { useClosedViewStore } from "../../closedViewStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { attachThreadFindTimeline, closeThreadFind, openThreadFind } from "../chat/threadFindStore";
import {
  type SideChatSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import {
  makeSideChatThreadFixture,
  makeStreamingTimelineFixture,
  makeThreadFixture,
  makeThreadProjectionFixture,
} from "../../test-fixtures";
import type { Thread } from "../../types";
import { askInSideChat } from "./openSideChat";
import { pendingSideChatThreadIds, usePendingSideChatStore } from "./pendingSideChatStore";
import { SideChatMapSurface } from "./SideChatMap";
import { SideChatPanel } from "./SideChatPanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const LESSON_ID = ThreadId.make("lesson-1");
const LESSON_REF = scopeThreadRef(ENVIRONMENT_ID, LESSON_ID);
const LESSON_PATH = "/environment-local/lesson-1";
const LESSON_SHELL = makeThreadFixture({
  id: LESSON_ID,
  environmentId: ENVIRONMENT_ID,
  title: "Reinforcement learning",
});
const sideChatRef = (id: string) => scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(id));

function sideChatShell(
  id: string,
  anchorThreadId: string,
  label: string,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    ...makeSideChatThreadFixture({
      id: ThreadId.make(id),
      lessonId: LESSON_ID,
      parentId: ThreadId.make(anchorThreadId),
      messageId: MessageId.make(`${anchorThreadId}-reply`),
      label,
    }),
    ...overrides,
  };
}

const SIDE_1 = sideChatShell("side-1", LESSON_ID, "observation space");
const SIDE_2 = sideChatShell("side-2", LESSON_ID, "reward shaping");
const NESTED_1 = sideChatShell("nested-1", "side-1", "Box");

/** The side chat's detail, as the quiet projection carries it once loaded. */
function sideChatProjection(
  shell: Thread,
  sideChat: Partial<OrchestrationV2SideChat> = {},
  projection: Partial<OrchestrationV2ThreadProjection> = {},
): EnvironmentThreadStructure {
  const base = makeThreadProjectionFixture();
  const anchor = shell.sideChat!.anchor;
  return {
    environmentId: ENVIRONMENT_ID,
    projection: {
      ...base,
      thread: {
        ...base.thread,
        id: shell.id,
        sideChat: {
          lessonThreadId: LESSON_ID,
          anchor,
          excerpt: shell.sideChat!.label,
          excerptContext: "",
          label: shell.sideChat!.label,
          opening: { status: "ready", text: null, requestId: "opening-1" },
          done: null,
          ...sideChat,
        },
      },
      ...projection,
    },
  };
}

/** A pending request of the side chat's AI, as the projection holds it. */
function pendingRequest(
  id: string,
  request: Pick<OrchestrationV2ThreadProjection["runtimeRequests"][number], "kind">,
  item: Record<string, unknown>,
): Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> {
  const createdAt = makeThreadProjectionFixture().updatedAt;
  return {
    runtimeRequests: [
      {
        id: RuntimeRequestId.make(id),
        nodeId: NodeId.make(id),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: request.kind,
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("session-1"),
        },
        createdAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make(id),
        threadId: SIDE_1.id,
        runId: null,
        nodeId: NodeId.make(id),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "running",
        title: null,
        startedAt: createdAt,
        completedAt: null,
        updatedAt: createdAt,
        requestId: RuntimeRequestId.make(id),
        ...item,
      } as OrchestrationV2ThreadProjection["turnItems"][number],
    ],
  };
}

function setup(dispatchResult: Promise<unknown> = Promise.resolve(AsyncResult.success({}))) {
  const dispatch = vi.fn((_value: unknown) => dispatchResult);
  state.dispatch = dispatch;
  state.shells = [LESSON_SHELL];
  state.projections = {};
  state.visibleTurnItems = [];
  state.marks = {};
  state.canOperate = true;
  state.citedHistoryRequests = [];
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  useClosedViewStore.setState({ entries: [] });
  usePendingSideChatStore.setState({ byThreadKey: {}, focusThreadKey: null });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  return dispatch;
}

/** Shows `threadId` in the tab of the top-level side chat `topThreadId`. */
function showSideChat(topThreadId: string, threadId: string) {
  useRightPanelStore.getState().openLessonSideChat(LESSON_REF, { topThreadId, threadId });
}

/** The replies the panel's timeline was asked to reveal, one per activation. */
const citedReplies = () =>
  state.citedHistoryRequests.map(({ threadId, messageId }) => ({ threadId, messageId }));
const SIDE_1_REPLY = { threadId: "side-1", messageId: "side-1-reply" };

const surfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LESSON_REF).surfaces;

/** The lesson's side-chat tab, as the right panel renders it. */
function Panel(props: { readonly onFocusLesson: () => void }) {
  const surface = useRightPanelStore((store) =>
    selectThreadRightPanelState(store.byThreadKey, LESSON_REF).surfaces.find(
      (entry): entry is SideChatSurface => entry.kind === "lesson-side-chat",
    ),
  );
  if (surface === undefined) return null;
  return (
    <SideChatPanel
      key={`${scopedThreadKey(LESSON_REF)}:${surface.id}`}
      lessonRef={LESSON_REF}
      surface={surface}
      visible
      onFocusLesson={props.onFocusLesson}
    />
  );
}

function renderPanel(
  options: { readonly router?: string; readonly onFocusLesson?: () => void } = {},
) {
  const container = document.createElement("div");
  container.style.cssText = "height: 480px; width: 900px; display: flex; flex-direction: column;";
  return render(<Panel onFocusLesson={options.onFocusLesson ?? (() => {})} />, {
    container,
    ...(options.router === undefined ? {} : { router: options.router }),
  });
}

const crumb = (screen: Screen, name: string) =>
  screen
    .getByRole("navigation", { name: "Side chat path" })
    .getByRole("button", { name, exact: true });
const composer = (screen: Screen) => screen.getByRole("textbox", { name: "Side chat message" });
const revealButton = (screen: Screen) =>
  screen.getByRole("button", { name: "Show this highlight where it was asked" });
const doneButton = (screen: Screen) => screen.getByRole("button", { name: "Done", exact: true });
const draft = (id: string) =>
  useComposerDraftStore.getState().getComposerDraft(sideChatRef(id))?.prompt ?? "";

/** Double-clicks `word` in the rendered reply `messageId`, which selects it as a reader would. */
async function selectReplyWord(screen: Screen, messageId: string, word: string) {
  const target = await vi.waitFor(() => {
    const source = screen.container.querySelector(
      `[data-assistant-citation-source="${messageId}"]`,
    );
    if (source === null) throw new Error(`${messageId} has not rendered`);
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(word) ?? -1;
      if (start === -1 || node.parentElement === null) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + word.length);
      const wordRect = range.getBoundingClientRect();
      const elementRect = node.parentElement.getBoundingClientRect();
      return {
        element: node.parentElement,
        position: {
          x: wordRect.left - elementRect.left + wordRect.width / 2,
          y: wordRect.top - elementRect.top + wordRect.height / 2,
        },
      };
    }
    throw new Error(`"${word}" has not rendered in ${messageId}`);
  });
  await userEvent.dblClick(target.element, { position: target.position });
}

it("shows a starting side chat with its excerpt and puts the cursor in its composer", async () => {
  setup();
  const citation: AssistantCitation = {
    version: 1,
    environmentId: ENVIRONMENT_ID,
    threadId: LESSON_ID,
    messageId: MessageId.make("lesson-1-reply"),
    text: "observation space",
    start: 3,
    end: 20,
    prefix: "An ",
    suffix: " is what the agent can see.",
  };
  // The server has not answered yet, so the side chat has no shell.
  const run = vi.fn(() => new Promise<never>(() => {}));
  await using screen = await renderPanel({ router: LESSON_PATH });

  await act(() =>
    askInSideChat({
      lessonRef: LESSON_REF,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run,
    }),
  );

  await expect.element(screen.getByText("Starting side chat…")).toBeVisible();
  await expect.element(revealButton(screen)).toHaveTextContent("observation space");
  await expect.element(crumb(screen, "observation space")).toHaveAttribute("aria-current", "page");
  await expect.element(composer(screen)).toHaveFocus();
  expect(screen.router?.state.location.pathname).toBe(LESSON_PATH);
});

it("puts the cursor in the composer when Ask lands on a highlight that already has a side chat", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  showSideChat("side-1", "side-1");
  const run = vi.fn(() => new Promise<never>(() => {}));
  await using screen = await renderPanel();
  await expect.element(composer(screen)).toBeInTheDocument();
  // Selecting the lesson's text takes focus out of the panel.
  (document.activeElement as HTMLElement).blur();

  await act(() =>
    askInSideChat({
      lessonRef: LESSON_REF,
      citation: {
        version: 1,
        environmentId: ENVIRONMENT_ID,
        threadId: LESSON_ID,
        messageId: MessageId.make("lesson-1-reply"),
        text: "space",
        start: 15,
        end: 20,
        prefix: "An observation ",
        suffix: " is what the agent can see.",
      },
      sideChatShells: state.shells as ReadonlyArray<Thread>,
      topThreadId: null,
      run,
    }),
  );

  await expect.element(composer(screen)).toHaveFocus();
  expect(run).not.toHaveBeenCalled();
});

/** The lesson's panel showing only its active tab, as the right panel does. */
function ActiveTab() {
  const surface = useRightPanelStore((store) => {
    const panel = selectThreadRightPanelState(store.byThreadKey, LESSON_REF);
    return panel.surfaces.find((entry) => entry.id === panel.activeSurfaceId);
  });
  if (surface?.kind === "thread-map") {
    return <SideChatMapSurface threadRef={LESSON_REF} onFocusLesson={() => {}} />;
  }
  if (surface?.kind !== "lesson-side-chat") return null;
  return (
    <SideChatPanel
      key={`${scopedThreadKey(LESSON_REF)}:${surface.id}`}
      lessonRef={LESSON_REF}
      surface={surface}
      visible
      onFocusLesson={() => {}}
    />
  );
}

it("puts the cursor in the composer of a side chat opened from the Map", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  useRightPanelStore.getState().open(LESSON_REF, "thread-map");
  const container = document.createElement("div");
  container.style.cssText = "height: 480px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(<ActiveTab />, { container });
  const node = screen.getByRole("treeitem", { name: "observation space", exact: true });
  await expect.element(node).toBeInTheDocument();

  (node.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");

  await expect.element(composer(screen)).toHaveFocus();
});

it("focuses another top-level side chat opened from an in-panel map", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1, SIDE_2];
  const panels = useRightPanelStore.getState();
  panels.openLessonSideChat(LESSON_REF, { topThreadId: "side-1", threadId: "side-1" });
  panels.setSideChatView(LESSON_REF, "side-chat:side-1", "map");
  panels.openLessonSideChat(LESSON_REF, { topThreadId: "side-2", threadId: "side-2" });
  panels.activateSurface(LESSON_REF, "side-chat:side-1");
  const container = document.createElement("div");
  container.style.cssText = "height: 480px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(<ActiveTab />, { container });

  await userEvent.click(screen.getByRole("treeitem", { name: "reward shaping", exact: true }));

  await expect.element(composer(screen)).toHaveFocus();
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LESSON_REF).surfaces,
  ).toContainEqual({
    id: "side-chat:side-1",
    kind: "lesson-side-chat",
    threadId: "side-1",
    view: "map",
  });
});

it("toggles the side-chat map, walks back to chat with its draft, and keeps lesson focus on the map", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1, NESTED_1];
  state.projections = { "side-1": sideChatProjection(SIDE_1) };
  showSideChat("side-1", "side-1");
  const onFocusLesson = vi.fn();
  await using screen = await renderPanel({ onFocusLesson });

  await userEvent.type(composer(screen), "kept draft");
  const toggle = screen.getByRole("button", { name: "Side-chat map" });
  await userEvent.click(toggle);
  await expect.element(screen.getByRole("tree", { name: "Side chat map" })).toBeVisible();
  await expect.element(composer(screen)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("treeitem", { name: "observation space", exact: true }));
  await expect.element(composer(screen)).toHaveFocus();
  expect(draft("side-1")).toBe("kept draft");

  await userEvent.click(screen.getByRole("button", { name: "Side-chat map" }));
  await userEvent.click(screen.getByRole("treeitem", { name: "Box", exact: true }));
  await expect.element(composer(screen)).toHaveFocus();

  await userEvent.click(screen.getByRole("button", { name: "Side-chat map" }));
  await userEvent.click(
    screen.getByRole("treeitem", { name: "Reinforcement learning", exact: true }),
  );
  expect(onFocusLesson).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("tree", { name: "Side chat map" })).toBeVisible();
});

it("puts the cursor in the composer of a nested side chat opened from its mark in the panel", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1, NESTED_1];
  state.projections = { "side-1": sideChatProjection(SIDE_1) };
  state.visibleTurnItems = makeStreamingTimelineFixture()
    .visibleTurnItems satisfies ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  // The whole reply "Done" is the highlight Box was asked about.
  state.marks = {
    "side-1:history-assistant": [
      {
        threadId: NESTED_1.id,
        label: "Box",
        state: "open",
        anchor: {
          threadId: SIDE_1.id,
          messageId: MessageId.make("history-assistant"),
          start: 0,
          end: 4,
          prefix: "",
          suffix: "",
        },
      },
    ],
  };
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await screen.getByRole("button", { name: "Open side chat “Box”" }).click();

  await expect.element(crumb(screen, "Box")).toHaveAttribute("aria-current", "page");
  await expect.element(composer(screen)).toHaveFocus();
});

it("keeps the excerpt and the empty conversation between the shell arriving and the detail loading", async () => {
  setup();
  const citation: AssistantCitation = {
    version: 1,
    environmentId: ENVIRONMENT_ID,
    threadId: LESSON_ID,
    messageId: MessageId.make("lesson-1-reply"),
    text: "observation space",
    start: 3,
    end: 20,
    prefix: "An ",
    suffix: " is what the agent can see.",
  };
  const run = vi.fn(() => new Promise<never>(() => {}));
  await using screen = await renderPanel({ router: LESSON_PATH });
  await act(() =>
    askInSideChat({
      lessonRef: LESSON_REF,
      citation,
      sideChatShells: [],
      topThreadId: null,
      run,
    }),
  );
  await expect.element(revealButton(screen)).toHaveTextContent("observation space");
  const lessonKey = scopedThreadKey(LESSON_REF);
  const [id] = pendingSideChatThreadIds(usePendingSideChatStore.getState(), lessonKey);

  // The shell lands and the lesson forgets the pending entry; the detail is still loading.
  state.shells = [LESSON_SHELL, sideChatShell(id!, LESSON_ID, "observation space")];
  act(() => usePendingSideChatStore.getState().prune(lessonKey, new Set([id!])));

  await expect.element(revealButton(screen)).toHaveTextContent("observation space");
  await expect
    .element(screen.getByText("What do you want to know about “observation space”?"))
    .toBeVisible();
  await expect
    .element(composer(screen))
    .toHaveAttribute("aria-placeholder", "Ask your own question…");
});

it("asks for a follow-up once the side chat has a message", async () => {
  setup();
  state.shells = [LESSON_SHELL, { ...SIDE_1, latestUserMessageAt: "2026-10-22T00:00:00.000Z" }];
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await expect.element(composer(screen)).toHaveAttribute("aria-placeholder", "Ask a follow-up…");
});

it("shows the side chat's queued messages under its timeline", async () => {
  setup();
  const at = makeThreadProjectionFixture().updatedAt;
  const run = (id: string, ordinal: number, status: "running" | "queued") =>
    ({
      id: RunId.make(id),
      threadId: SIDE_1.id,
      ordinal,
      providerInstanceId: SIDE_1.modelSelection.instanceId,
      modelSelection: SIDE_1.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`${id}-question`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: status === "running" ? at : null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    }) satisfies OrchestrationV2ThreadProjection["runs"][number];
  const question = (runId: string, text: string) =>
    ({
      id: MessageId.make(`${runId}-question`),
      threadId: SIDE_1.id,
      runId: RunId.make(runId),
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: at,
      updatedAt: at,
    }) satisfies OrchestrationV2ThreadProjection["messages"][number];
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = {
    "side-1": sideChatProjection(
      SIDE_1,
      {},
      {
        runs: [run("run-1", 1, "running"), run("run-2", 2, "queued")],
        messages: [
          question("run-1", "What is a Box?"),
          question("run-2", "Is a Discrete space a Box too?"),
        ],
      },
    ),
  };
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();
  const queue = screen.getByRole("region", { name: "1 queued message" });
  await expect.element(queue.getByText("Is a Discrete space a Box too?")).toBeVisible();
  await expect.element(queue.getByRole("button", { name: "Edit queued message" })).toBeDisabled();
});

it("Done on a nested side chat returns to its parent without waiting for the note", async () => {
  // The finish never settles: the panel must not wait for the note.
  const dispatch = setup(new Promise(() => {}));
  state.shells = [LESSON_SHELL, SIDE_1, NESTED_1];
  showSideChat("side-1", "nested-1");
  await using screen = await renderPanel();

  await doneButton(screen).click();

  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: "nested-1" },
  });
  expect(surfaces()).toEqual([
    {
      id: "side-chat:side-1",
      kind: "lesson-side-chat",
      threadId: "side-1",
      trail: ["side-1", "nested-1"],
    },
  ]);
});

it("Done on a top-level side chat closes its tab and remembers it for reopening", async () => {
  const dispatch = setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await doneButton(screen).click();

  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: "side-1" },
  });
  expect(surfaces()).toEqual([]);
  expect(useClosedViewStore.getState().entries).toEqual([
    {
      id: expect.any(String),
      kind: "panel-tab",
      threadRef: LESSON_REF,
      surface: { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" },
    },
  ]);
});

it("Done on a finished side chat closes its tab without dispatching finish", async () => {
  const dispatch = setup();
  const finished = {
    ...SIDE_1,
    sideChat: { ...SIDE_1.sideChat!, state: "done" as const },
  };
  state.shells = [LESSON_SHELL, finished];
  showSideChat("side-1", "side-1");
  const onFocusLesson = vi.fn();
  await using screen = await renderPanel({ onFocusLesson });

  await expect.element(doneButton(screen)).toBeVisible();
  await doneButton(screen).click();

  expect(dispatch).not.toHaveBeenCalled();
  expect(surfaces()).toEqual([]);
  expect(onFocusLesson).toHaveBeenCalledOnce();
});

it("Discard finishes the side chat without a note and forgets its draft", async () => {
  const dispatch = setup();
  const written: Thread = {
    ...SIDE_1,
    latestUserMessageAt: "2026-10-22T00:00:00.000Z",
  };
  state.shells = [LESSON_SHELL, written];
  useComposerDraftStore.getState().setPrompt(sideChatRef("side-1"), "And the reward?");
  const file = new File([new Uint8Array([137, 80, 78])], "reward.png", { type: "image/png" });
  useComposerDraftStore.getState().addImage(sideChatRef("side-1"), {
    type: "image",
    id: "reward-image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  });
  useComposerDraftStore
    .getState()
    .setModelSelection(
      sideChatRef("side-1"),
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3"),
      { explicit: true },
    );
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await screen.getByRole("button", { name: "More side chat actions" }).click();
  await page.getByRole("menuitem", { name: "Discard" }).click();

  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: "side-1", discard: true },
  });
  expect(surfaces()).toEqual([]);
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(sideChatRef("side-1"))).toBeNull(),
  );
});

it("Done on an empty side chat forgets its draft, which nothing can reach once it is deleted", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  useComposerDraftStore.getState().setPrompt(sideChatRef("side-1"), "And the reward?");
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await doneButton(screen).click();

  await vi.waitFor(() => expect(draft("side-1")).toBe(""));
});

const lessonMessage = () => page.getByRole("textbox", { name: "Lesson message" });

/** The panel beside a stand-in for the lesson's composer, which the panel hands the cursor to. */
function renderPanelBesideLesson() {
  const container = document.createElement("div");
  container.style.cssText = "height: 480px; width: 900px; display: flex; flex-direction: column;";
  return render(
    <>
      <textarea aria-label="Lesson message" />
      <Panel onFocusLesson={() => (lessonMessage().element() as HTMLElement).focus()} />
    </>,
    { container },
  );
}

it("hands the cursor to the lesson when Discard closes the side chat's tab", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  showSideChat("side-1", "side-1");
  await using screen = await renderPanelBesideLesson();
  const actions = screen.getByRole("button", { name: "More side chat actions" });
  await expect.element(actions).toBeInTheDocument();

  (actions.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitem", { name: "Side chat settings" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitem", { name: "Discard" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");

  expect(surfaces()).toEqual([]);
  await expect.element(lessonMessage()).toHaveFocus();
});

it("hands the cursor to the lesson when Done closes a side chat's tab beside another", async () => {
  setup();
  const side2 = sideChatShell("side-2", LESSON_ID, "reward signal");
  state.shells = [LESSON_SHELL, SIDE_1, side2];
  showSideChat("side-1", "side-1");
  showSideChat("side-2", "side-2");
  await using screen = await renderPanelBesideLesson();
  await expect.element(crumb(screen, "observation space")).toHaveAttribute("aria-current", "page");

  (doneButton(screen).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");

  await expect.element(crumb(screen, "reward signal")).toHaveAttribute("aria-current", "page");
  await expect.element(lessonMessage()).toHaveFocus();
});

it("walks the breadcrumb Lesson › observation space › Box in place", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1, NESTED_1];
  showSideChat("side-1", "nested-1");
  const onFocusLesson = vi.fn();
  await using screen = await renderPanel({ onFocusLesson });

  await expect.element(crumb(screen, "Box")).toHaveAttribute("aria-current", "page");
  await crumb(screen, "observation space").click();
  expect(surfaces()).toEqual([
    {
      id: "side-chat:side-1",
      kind: "lesson-side-chat",
      threadId: "side-1",
      trail: ["side-1", "nested-1"],
    },
  ]);
  await expect.element(crumb(screen, "observation space")).toHaveAttribute("aria-current", "page");

  await crumb(screen, "Box").click();
  expect(surfaces()).toEqual([
    { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "nested-1" },
  ]);

  await crumb(screen, "Lesson").click();
  expect(onFocusLesson).toHaveBeenCalledOnce();
});

/** A finished side chat whose note is ready, and the parent that may have received it. */
function doneWithNote(
  shell: Thread,
  note: string,
  parentDeliveries: OrchestrationV2AppThread["sideChatNoteDeliveries"],
) {
  const done: Thread = {
    ...shell,
    sideChat: { ...shell.sideChat!, state: "done", noteStatus: "ready" },
  };
  const parentId = shell.sideChat!.anchor.threadId;
  const base = makeThreadProjectionFixture();
  const parent: EnvironmentThreadStructure = {
    environmentId: ENVIRONMENT_ID,
    projection: {
      ...base,
      thread: { ...base.thread, id: parentId, sideChatNoteDeliveries: parentDeliveries },
    },
  };
  return {
    done,
    projections: {
      [done.id]: sideChatProjection(done, {
        done: {
          at: "2026-10-22T00:00:00.000Z",
          outcome: { status: "ready", note, requestId: "note-1" },
        },
      }),
      [parentId]: parent,
    },
  };
}

it("shows the note a finished side chat sent to the lesson", async () => {
  setup();
  const note = "They didn't know what an observation space is.";
  const { done, projections } = doneWithNote(SIDE_1, note, { [SIDE_1.id]: "note-1" });
  state.shells = [LESSON_SHELL, done];
  state.projections = projections;
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await expect.element(screen.getByText(`Sent to lesson: ${note}`)).toBeInTheDocument();
  await expect.element(doneButton(screen)).toBeVisible();
});

it("says a nested side chat's note waits for the parent side chat it goes to", async () => {
  setup();
  const note = "They mixed up Box and Discrete.";
  // side-1 received an earlier note of this side chat, not this one.
  const { done, projections } = doneWithNote(NESTED_1, note, { [NESTED_1.id]: "older-note" });
  state.shells = [LESSON_SHELL, SIDE_1, done];
  state.projections = projections;
  showSideChat("side-1", "nested-1");
  await using screen = await renderPanel();

  await expect
    .element(screen.getByText(`Goes with your next message in “observation space”: ${note}`))
    .toBeInTheDocument();
});

it("brings the lesson into view to reveal a top-level side chat's highlight there", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = { "side-1": sideChatProjection(SIDE_1) };
  showSideChat("side-1", "side-1");
  useRightPanelStore.getState().setMaximized(LESSON_REF, true);
  await using screen = await renderPanel({ router: LESSON_PATH });

  await revealButton(screen).click();

  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LESSON_REF).maximized,
  ).toBeUndefined();
  await vi.waitFor(() => expect(screen.router?.state.location.hash).not.toBe(""));
  expect(screen.router?.state.location.pathname).toBe(LESSON_PATH);
});

it("reveals a nested highlight in its parent side chat inside the panel", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1, NESTED_1];
  state.projections = {
    "side-1": sideChatProjection(SIDE_1),
    "nested-1": sideChatProjection(NESTED_1),
  };
  state.visibleTurnItems = makeStreamingTimelineFixture()
    .visibleTurnItems satisfies ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  showSideChat("side-1", "nested-1");
  await using screen = await renderPanel();

  await expect.element(revealButton(screen)).toHaveTextContent("Box");
  await revealButton(screen).click();

  expect(surfaces()).toMatchObject([{ id: "side-chat:side-1", threadId: "side-1" }]);
  await vi.waitFor(() => expect(citedReplies()).toEqual([SIDE_1_REPLY]));

  // Walking forward and back returns to side-1 without revealing the highlight again.
  await crumb(screen, "Box").click();
  await expect.element(crumb(screen, "Box")).toHaveAttribute("aria-current", "page");
  await crumb(screen, "observation space").click();
  await expect.element(crumb(screen, "observation space")).toHaveAttribute("aria-current", "page");
  expect(citedReplies()).toEqual([SIDE_1_REPLY]);
});

it("quotes a selection cited inside the panel into the side chat's draft, not the lesson's", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = { "side-1": sideChatProjection(SIDE_1) };
  state.visibleTurnItems = makeStreamingTimelineFixture()
    .visibleTurnItems satisfies ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await selectReplyWord(screen, "history-assistant", "Done");
  await page.getByRole("button", { name: "Cite selection in composer" }).click();

  await vi.waitFor(() =>
    expect(
      collectAssistantCitations(draft("side-1")).map(({ citation }) => [
        citation.threadId,
        citation.messageId,
        citation.text,
      ]),
    ).toEqual([["side-1", "history-assistant", "Done"]]),
  );
  expect(useComposerDraftStore.getState().getComposerDraft(LESSON_REF)).toBeNull();
});

it("offers a read-only connection no nested side chat to ask", async () => {
  setup();
  state.canOperate = false;
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = { "side-1": sideChatProjection(SIDE_1) };
  state.visibleTurnItems = makeStreamingTimelineFixture()
    .visibleTurnItems satisfies ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await selectReplyWord(screen, "history-assistant", "Done");

  await expect
    .element(page.getByRole("button", { name: "Cite selection in composer" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Ask in side chat" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Side-chat map" })).not.toBeDisabled();
});

/** A citation of side-1's own reply, which side-1's loaded history lacks. */
const SIDE_1_CITATION: AssistantCitation = {
  version: 1,
  environmentId: ENVIRONMENT_ID,
  threadId: SIDE_1.id,
  messageId: MessageId.make("side-1-reply"),
  text: "a bounded space",
  start: 2,
  end: 17,
  prefix: "A ",
  suffix: ".",
};

/** side-1 with its history loaded, and a reply cited from it. */
function setupSide1History(userText = "Inspect") {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = { "side-1": sideChatProjection(SIDE_1) };
  state.visibleTurnItems = makeStreamingTimelineFixture().visibleTurnItems.map((entry) =>
    entry.item.type === "user_message" && entry.item.text === "Inspect"
      ? { ...entry, item: { ...entry.item, text: userText } }
      : entry,
  ) satisfies ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  showSideChat("side-1", "side-1");
}

it("reveals a side-chat reply cited in its draft in the panel, not on the side chat's route", async () => {
  setupSide1History();
  useComposerDraftStore
    .getState()
    .setPrompt(sideChatRef("side-1"), `${serializeAssistantCitation(SIDE_1_CITATION)} `);
  await using screen = await renderPanel({ router: LESSON_PATH });

  await screen.getByRole("link", { name: "View cited assistant text: a bounded space" }).click();

  await vi.waitFor(() => expect(citedReplies()).toEqual([SIDE_1_REPLY]));
  expect(screen.router?.state.location.pathname).toBe(LESSON_PATH);
  expect(surfaces()).toEqual([
    { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" },
  ]);
});

it("goes to the source of a sent side-chat citation in the panel, not on its route", async () => {
  setupSide1History(`${serializeAssistantCitation(SIDE_1_CITATION)} what is this?`);
  await using screen = await renderPanel({ router: LESSON_PATH });

  await screen
    .getByRole("button", { name: "Quoted assistant text: a bounded space. Show details" })
    .click();
  await page.getByRole("link", { name: "Go to source" }).click();

  await vi.waitFor(() => expect(citedReplies()).toEqual([SIDE_1_REPLY]));
  expect(screen.router?.state.location.pathname).toBe(LESSON_PATH);
  expect(surfaces()).toEqual([
    { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" },
  ]);
});

it("leaves the lesson's find alone while the side chat's timeline shows", async () => {
  setupSide1History();
  const lessonKey = scopedThreadKey(LESSON_REF);
  const navigateLesson = vi.fn();
  using _lessonTimeline = {
    [Symbol.dispose]: attachThreadFindTimeline({
      threadKey: lessonKey,
      readPosition: () => undefined,
      navigate: navigateLesson,
    }),
  };
  CSS.highlights.set("t3-thread-find", new Highlight());
  using _highlights = { [Symbol.dispose]: () => CSS.highlights.delete("t3-thread-find") };
  await using screen = await render(<Panel onFocusLesson={() => {}} />, {
    router: LESSON_PATH,
  });
  using _find = { [Symbol.dispose]: closeThreadFind };

  await expect.element(screen.getByText("Inspect")).toBeInTheDocument();
  openThreadFind(lessonKey);

  expect(navigateLesson).toHaveBeenCalledOnce();
  expect(CSS.highlights.has("t3-thread-find")).toBe(true);
});

it("types into the side chat when focus is elsewhere in the panel", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();
  const panel = screen.getByRole("region", { name: "Side chat" });
  await expect.element(panel).toBeInTheDocument();

  (panel.element() as HTMLElement).focus();
  await userEvent.keyboard("w");

  expect(draft("side-1")).toBe("w");
  await expect.element(composer(screen)).toHaveFocus();
});

it("leaves PageUp to a draft that can scroll and pages the timeline otherwise", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  useComposerDraftStore.getState().setPrompt(sideChatRef("side-1"), lines.join("\n"));
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();
  const pageUp = (target: Element) => {
    const event = new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  const editor = await vi.waitFor(() => {
    const element = composer(screen).element() as HTMLElement;
    if (element.scrollHeight <= element.clientHeight) throw new Error("the draft fits");
    return element;
  });
  editor.scrollTop = editor.scrollHeight;
  expect(editor.scrollTop).toBeGreaterThan(0);
  expect(pageUp(editor).defaultPrevented).toBe(false);

  expect(pageUp(screen.getByRole("region", { name: "Side chat" }).element()).defaultPrevented).toBe(
    true,
  );
});

it("answers an approval the side chat's AI is waiting on from the panel", async () => {
  const dispatch = setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = {
    "side-1": sideChatProjection(
      SIDE_1,
      {},
      pendingRequest(
        "approval-1",
        { kind: "command" },
        { type: "approval_request", requestKind: "command", prompt: "vp test" },
      ),
    ),
  };
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await screen.getByRole("button", { name: "Approve" }).click();

  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: "side-1", requestId: "approval-1", decision: "accept" },
  });
});

it("answers a question the side chat's AI asked from the panel", async () => {
  const dispatch = setup();
  useComposerDraftStore.getState().setPrompt(sideChatRef("side-1"), "A follow-up");
  state.shells = [LESSON_SHELL, SIDE_1];
  state.projections = {
    "side-1": sideChatProjection(
      SIDE_1,
      {},
      pendingRequest(
        "question-1",
        { kind: "user_input" },
        {
          type: "user_input_request",
          questions: [
            {
              id: "q1",
              header: "Space",
              question: "Which space do you mean?",
              options: [
                { label: "Box", description: "A bounded space of numbers" },
                { label: "Discrete", description: "A finite set of choices" },
              ],
            },
          ],
        },
      ),
    ),
  };
  showSideChat("side-1", "side-1");
  await using screen = await renderPanel();

  await expect.element(screen.getByText("Which space do you mean?")).toBeVisible();
  await expect.element(composer(screen)).not.toHaveTextContent("A follow-up");
  await composer(screen).click();
  await userEvent.keyboard("The one with bounds");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        threadId: "side-1",
        requestId: "question-1",
        answers: { q1: "The one with bounds" },
      },
    }),
  );
  expect(draft("side-1")).toBe("A follow-up");
});
