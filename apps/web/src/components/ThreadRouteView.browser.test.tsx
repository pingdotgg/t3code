import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<{ readonly id: string }>,
  shellStatus: "live" as string,
}));

vi.mock(import("../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null
      ? null
      : (state.shells.find((shell) => shell.id === ref.threadId) ?? null)) as never,
  readSideChatTreeShells: (() => state.shells) as never,
}));

vi.mock(import("../state/shell"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentShellStatus: (() => state.shellStatus) as never,
}));

// A tagged lesson and its side chat, as upstream's tag filter hides them while recording.
vi.mock(import("../state/threads"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom } = await import("effect/reactivity");
  const { threadKey } = await import("@t3tools/client-runtime/state/entities");
  const environmentId = EnvironmentId.make("environment-local");
  const hidden: ReadonlySet<string> = new Set(
    ["private-lesson", "private-side"].map((id) =>
      threadKey({ environmentId, threadId: ThreadId.make(id) }),
    ),
  );
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      hiddenThreadKeysAtom: Atom.make(() => hidden),
    },
  };
});

vi.mock(import("./ChatView"), async () => {
  const { createElement } = await import("react");
  return { default: (() => createElement("p", null, "Chat view")) as never };
});

import { render } from "../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { makeSideChatThreadFixture, makeThreadFixture } from "../test-fixtures";
import { usePendingSideChatStore } from "./sideChat/pendingSideChatStore";
import { ThreadRouteView } from "./ThreadRouteView";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const LESSON_ID = ThreadId.make("lesson-1");
const LESSON_REF = scopeThreadRef(ENVIRONMENT_ID, LESSON_ID);
const LESSON_SHELL = makeThreadFixture({ id: LESSON_ID, environmentId: ENVIRONMENT_ID });
const SIDE_1 = makeSideChatThreadFixture({
  id: ThreadId.make("side-1"),
  lessonId: LESSON_ID,
  parentId: LESSON_ID,
  messageId: MessageId.make("lesson-1-reply"),
  label: "observation space",
});
const NESTED_1 = makeSideChatThreadFixture({
  id: ThreadId.make("nested-1"),
  lessonId: LESSON_ID,
  parentId: SIDE_1.id,
  messageId: MessageId.make("side-1-reply"),
  label: "Box",
});

function setup() {
  state.shells = [LESSON_SHELL, SIDE_1, NESTED_1];
  state.shellStatus = "live";
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  usePendingSideChatStore.setState({ byThreadKey: {}, focusThreadKey: null });
}

it("renders a lesson's own route as its chat view", async () => {
  setup();

  await using screen = await render(
    <ThreadRouteView target={{ kind: "server", threadRef: LESSON_REF }} />,
    { router: "/environment-local/lesson-1" },
  );

  await expect.element(screen.getByText("Chat view")).toBeVisible();
});

it("settles a side chat's route on its lesson with the side chat in the panel", async () => {
  setup();

  await using screen = await render(
    <ThreadRouteView
      target={{ kind: "server", threadRef: scopeThreadRef(ENVIRONMENT_ID, NESTED_1.id) }}
    />,
    { router: "/environment-local/nested-1" },
  );

  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment-local/lesson-1"),
  );
  // Replaced, so Back does not land on the side chat's route again.
  expect(screen.router?.history.length).toBe(1);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LESSON_REF).surfaces,
  ).toEqual([{ id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "nested-1" }]);
  // Like every other way into a side chat, its composer takes the cursor once the panel shows it.
  expect(usePendingSideChatStore.getState().focusThreadKey).toBe(
    scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, NESTED_1.id)),
  );
  await expect.element(screen.getByText("Chat view")).not.toBeInTheDocument();
});

it("waits for the live shell, so a side chat deleted since the cached one stays missing", async () => {
  setup();
  // A reload reads the cached shell first, which can predate the side chat's deletion.
  state.shellStatus = "cached";
  const target = { kind: "server", threadRef: scopeThreadRef(ENVIRONMENT_ID, SIDE_1.id) } as const;
  await using screen = await render(<ThreadRouteView target={target} />, {
    router: "/environment-local/side-1",
  });

  state.shellStatus = "live";
  state.shells = [LESSON_SHELL, { ...SIDE_1, deletedAt: "2026-10-22T00:00:01.000Z" }, NESTED_1];
  await screen.rerender(<ThreadRouteView target={target} />);

  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LESSON_REF).surfaces,
  ).toEqual([]);
  expect(screen.router?.state.location.pathname).toBe("/environment-local/side-1");
  await expect.element(screen.getByText("Chat view")).not.toBeInTheDocument();
});

it("leaves a hidden lesson's side chat route without revealing it", async () => {
  setup();
  const privateLesson = makeThreadFixture({
    id: ThreadId.make("private-lesson"),
    environmentId: ENVIRONMENT_ID,
  });
  const privateSide = makeSideChatThreadFixture({
    id: ThreadId.make("private-side"),
    lessonId: privateLesson.id,
  });
  state.shells = [...state.shells, privateLesson, privateSide];

  await using screen = await render(
    <ThreadRouteView
      target={{ kind: "server", threadRef: scopeThreadRef(ENVIRONMENT_ID, privateSide.id) }}
    />,
    { router: "/environment-local/private-side" },
  );

  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  expect(
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      scopeThreadRef(ENVIRONMENT_ID, privateLesson.id),
    ).surfaces,
  ).toEqual([]);
  expect(usePendingSideChatStore.getState().focusThreadKey).toBeNull();
});
