import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<{ readonly id: string }>,
  threadShells: [] as ReadonlyArray<{ readonly id: string }>,
  shellStatus: "live" as string | null,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSideChatTreeShells: ((ref: unknown) => (ref === null ? [] : state.shells)) as never,
  readSideChatTreeShells: (() => state.shells) as never,
  readThreadShell: ((ref: { threadId: string }) =>
    state.threadShells.find((shell) => shell.id === ref.threadId) ?? null) as never,
}));

vi.mock(import("../../state/shell"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentShellStatus: (() => state.shellStatus) as never,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => async () => undefined) as never,
}));

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { makeSideChatThreadFixture, makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
import { usePendingSideChatStore } from "./pendingSideChatStore";
import { useLessonSideChats } from "./useLessonSideChats";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const LESSON_ID = ThreadId.make("lesson-1");
const LESSON_REF = scopeThreadRef(ENVIRONMENT_ID, LESSON_ID);
const LESSON_SHELL = makeThreadFixture({ id: LESSON_ID, environmentId: ENVIRONMENT_ID });

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

const CITATION: AssistantCitation = {
  version: 1,
  environmentId: ENVIRONMENT_ID,
  threadId: LESSON_ID,
  messageId: MessageId.make("lesson-1-reply"),
  text: "action space",
  start: 30,
  end: 42,
  prefix: "and an ",
  suffix: ".",
};

type LessonSideChats = ReturnType<typeof useLessonSideChats>;
type LessonSideChatsInput = Parameters<typeof useLessonSideChats>[0];

function Probe(props: {
  readonly input: LessonSideChatsInput;
  readonly onResult: (result: LessonSideChats) => void;
}) {
  props.onResult(useLessonSideChats(props.input));
  return null;
}

const lessonInput = (overrides: Partial<LessonSideChatsInput> = {}): LessonSideChatsInput => ({
  lessonRef: LESSON_REF,
  supported: true,
  capabilityKnown: true,
  activityRunStatus: null,
  ...overrides,
});

function setup() {
  state.shells = [LESSON_SHELL];
  state.threadShells = [];
  state.shellStatus = "live";
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  usePendingSideChatStore.setState({ byThreadKey: {} });
}

/** Shows `threadId` in the tab of the top-level side chat `topThreadId`. */
function showSideChat(topThreadId: string, threadId = topThreadId) {
  useRightPanelStore.getState().openLessonSideChat(LESSON_REF, { topThreadId, threadId });
}

const surfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LESSON_REF).surfaces;

it("drops tabs of side chats that are gone but keeps one that is still starting", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  showSideChat("side-1");
  showSideChat("side-gone");
  showSideChat("side-new");
  // Asked for from the lesson; the server has not answered, so it has no shell yet.
  usePendingSideChatStore
    .getState()
    .begin(scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("side-new"))), {
      threadId: ThreadId.make("side-new"),
      lessonThreadKey: scopedThreadKey(LESSON_REF),
      citation: CITATION,
      status: "starting",
    });
  let result: LessonSideChats | undefined;

  await using _screen = await render(
    <Probe input={lessonInput()} onResult={(next) => (result = next)} />,
  );

  expect(surfaces().map((surface) => surface.id)).toEqual([
    "side-chat:side-1",
    "side-chat:side-new",
  ]);
  expect(result?.onAskInSideChat).toBeTypeOf("function");
  expect([...(result?.labelsById ?? [])]).toEqual([["side-1", "observation space"]]);
});

it("keeps side-chat tabs while the shell is only the cached one from the last visit", async () => {
  setup();
  // A reload restores shells cached before the newest side chats were asked for.
  state.shellStatus = "cached";
  state.shells = [LESSON_SHELL];
  showSideChat("side-1");
  showSideChat("side-2", "nested-2");
  useRightPanelStore
    .getState()
    .navigateSideChat(LESSON_REF, "side-chat:side-2", ["side-2"], ["side-2", "nested-2"]);
  const before = surfaces();

  await using screen = await render(<Probe input={lessonInput()} onResult={() => {}} />);

  expect(surfaces()).toEqual(before);

  state.shellStatus = "live";
  state.shells = [LESSON_SHELL, SIDE_1];
  await screen.rerender(<Probe input={lessonInput()} onResult={() => {}} />);

  expect(surfaces().map((surface) => surface.id)).toEqual(["side-chat:side-1"]);
});

it("clears the unsent drafts of side chats that are gone", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  showSideChat("side-1", "nested-gone");
  showSideChat("side-gone");
  const drafts = useComposerDraftStore.getState();
  const draftRef = (id: string) => scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(id));
  drafts.setPrompt(draftRef("side-1"), "Kept question");
  drafts.setPrompt(draftRef("nested-gone"), "Nested question");
  drafts.setPrompt(draftRef("side-gone"), "Lost question");

  await using _screen = await render(<Probe input={lessonInput()} onResult={() => {}} />);

  expect(surfaces()).toEqual([
    { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" },
  ]);
  const after = useComposerDraftStore.getState();
  expect(after.getComposerDraft(draftRef("side-1"))?.prompt).toBe("Kept question");
  expect(after.getComposerDraft(draftRef("nested-gone"))).toBeNull();
  expect(after.getComposerDraft(draftRef("side-gone"))).toBeNull();
});

it("keeps the unsent draft of a side chat archived with its lesson", async () => {
  setup();
  // Archiving the lesson archives its side chats, and unarchiving brings them back.
  state.threadShells = [
    sideChatShell("side-1", LESSON_ID, "observation space", {
      archivedAt: "2026-10-24T00:00:00.000Z",
    }),
  ];
  showSideChat("side-1");
  const draftRef = scopeThreadRef(ENVIRONMENT_ID, SIDE_1.id);
  useComposerDraftStore.getState().setPrompt(draftRef, "Kept question");

  await using _screen = await render(<Probe input={lessonInput()} onResult={() => {}} />);

  expect(surfaces()).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(draftRef)?.prompt).toBe("Kept question");
});

it("opens the side chat whose AI is waiting for an answer", async () => {
  setup();
  const waiting = sideChatShell("nested-1", "side-1", "Box", { hasPendingApprovals: true });
  state.shells = [LESSON_SHELL, SIDE_1, waiting];

  await using screen = await render(<Probe input={lessonInput()} onResult={() => {}} />);

  expect(surfaces()).toEqual([
    { id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "nested-1" },
  ]);

  // Closing it sticks while it still waits: only a newly waiting side chat opens again.
  useRightPanelStore.getState().closeSurface(LESSON_REF, "side-chat:side-1");
  state.shells = [LESSON_SHELL, SIDE_1, { ...waiting }];
  await screen.rerender(<Probe input={lessonInput()} onResult={() => {}} />);

  expect(surfaces()).toEqual([]);
});

it("offers no Ask and drops side-chat and Map tabs without the side-chats capability", async () => {
  setup();
  state.shells = [LESSON_SHELL, SIDE_1];
  const store = useRightPanelStore.getState();
  store.open(LESSON_REF, "diff");
  showSideChat("side-1");
  store.open(LESSON_REF, "thread-map");
  let result: LessonSideChats | undefined;

  await using _screen = await render(
    <Probe input={lessonInput({ supported: false })} onResult={(next) => (result = next)} />,
  );

  expect(surfaces().map((surface) => surface.id)).toEqual(["diff"]);
  expect(result).toBeDefined();
  expect(result?.onAskInSideChat).toBeUndefined();
});
