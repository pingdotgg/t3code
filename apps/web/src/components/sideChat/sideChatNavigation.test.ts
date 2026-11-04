import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type RightPanelSurface,
  type SideChatSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { makeSideChatThreadFixture, makeThreadFixture } from "../../test-fixtures";
import {
  isSideChatNotificationQuiet,
  resolveFinishableSideChat,
  resolveThreadOpenTarget,
  returnToLesson,
  sideChatLessonRef,
} from "./sideChatNavigation";

const environmentId = EnvironmentId.make("environment-test");
const lessonId = ThreadId.make("lesson");
const sideId = ThreadId.make("side");
const nestedId = ThreadId.make("nested");

const lesson = makeThreadFixture({ id: lessonId, title: "Lesson" });
const side = makeSideChatThreadFixture({ id: sideId, lessonId });
const nested = makeSideChatThreadFixture({
  id: nestedId,
  lessonId,
  parentId: sideId,
  label: "Box",
});

describe("side-chat navigation targets", () => {
  it("opens a side chat on its lesson's route and an ordinary thread on its own", () => {
    expect(resolveThreadOpenTarget(lesson)).toEqual({
      routeThreadId: lessonId,
      sideChatThreadId: null,
    });
    expect(resolveThreadOpenTarget(nested)).toEqual({
      routeThreadId: lessonId,
      sideChatThreadId: nestedId,
    });
    expect(sideChatLessonRef(nested)).toEqual({ environmentId, threadId: lessonId });
    expect(sideChatLessonRef(lesson)).toEqual({ environmentId, threadId: lessonId });
  });

  it("keeps side-chat notifications quiet only while their lesson is on screen", () => {
    const onScreen = {
      environmentId,
      thread: nested,
      activeEnvironmentId: environmentId,
      activeThreadId: lessonId,
      documentActive: true,
    };
    expect(isSideChatNotificationQuiet(onScreen)).toBe(true);
    expect(isSideChatNotificationQuiet({ ...onScreen, documentActive: false })).toBe(false);
    expect(isSideChatNotificationQuiet({ ...onScreen, activeThreadId: "fork" })).toBe(false);
    expect(isSideChatNotificationQuiet({ ...onScreen, activeEnvironmentId: "elsewhere" })).toBe(
      false,
    );
    expect(isSideChatNotificationQuiet({ ...onScreen, thread: lesson })).toBe(false);
  });
});

describe("resolveFinishableSideChat", () => {
  const surface: SideChatSurface = {
    id: "side-chat:side",
    kind: "lesson-side-chat",
    threadId: nestedId,
  };
  const map: RightPanelSurface = { id: "thread-map", kind: "thread-map" };
  const input = {
    surfaces: [surface, map],
    activeSurfaceId: surface.id,
    shells: [lesson, side, nested],
    environmentId,
  };

  it("returns the open or finished side chat the panel shows", () => {
    expect(resolveFinishableSideChat(input)).toEqual({
      threadId: nestedId,
      label: "Box",
      surface,
      finished: false,
    });

    const doneNested = makeSideChatThreadFixture({
      id: nestedId,
      lessonId,
      parentId: sideId,
      label: "Box",
      state: "done",
    });
    expect(resolveFinishableSideChat({ ...input, shells: [lesson, side, doneNested] })).toEqual({
      threadId: nestedId,
      label: "Box",
      surface,
      finished: true,
    });
    expect(resolveFinishableSideChat({ ...input, activeSurfaceId: map.id })).toBeNull();
    expect(resolveFinishableSideChat({ ...input, surfaces: [], activeSurfaceId: null })).toBeNull();
  });
});

describe("returnToLesson", () => {
  it("hides the panel first when it is a sheet over the lesson, keeping its tabs", () => {
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    const lessonRef = scopeThreadRef(environmentId, lessonId);
    const panel = () =>
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, lessonRef);
    useRightPanelStore
      .getState()
      .openLessonSideChat(lessonRef, { topThreadId: sideId, threadId: sideId });
    const focusComposer = vi.fn();

    returnToLesson(lessonRef, false, focusComposer);
    expect(panel().isOpen).toBe(true);
    expect(focusComposer).toHaveBeenCalledOnce();

    returnToLesson(lessonRef, true, focusComposer);
    expect(panel().isOpen).toBe(false);
    expect(panel().surfaces).toEqual([
      { id: "side-chat:side", kind: "lesson-side-chat", threadId: sideId },
    ]);
    expect(focusComposer).toHaveBeenCalledTimes(2);
  });

  it("un-maximizes the panel, which would otherwise hide the lesson it focuses", () => {
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    const lessonRef = scopeThreadRef(environmentId, lessonId);
    const panels = useRightPanelStore.getState();
    panels.openLessonSideChat(lessonRef, { topThreadId: sideId, threadId: sideId });
    panels.setMaximized(lessonRef, true);

    returnToLesson(lessonRef, false, () => {});

    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, lessonRef);
    expect(panel.maximized).toBeUndefined();
    expect(panel.isOpen).toBe(true);
  });
});
