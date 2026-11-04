import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<{ readonly id: string }>,
  finish: vi.fn(),
}));

vi.mock(import("../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  readThreadShell: ((ref: { threadId: string }) =>
    state.shells.find((shell) => shell.id === ref.threadId) ?? null) as never,
}));

vi.mock(import("../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => state.finish) as never,
}));

vi.mock(import("../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

import { render } from "../../test/render";
import { useComposerDraftStore } from "../composerDraftStore";
import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { makeSideChatThreadFixture, makeThreadFixture } from "../test-fixtures";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const LESSON_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("lesson-1"));
const SIDE_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("side-1"));

function setup() {
  state.shells = [
    makeThreadFixture({ id: LESSON_REF.threadId, environmentId: ENVIRONMENT_ID }),
    makeSideChatThreadFixture({
      id: SIDE_REF.threadId,
      lessonId: LESSON_REF.threadId,
      environmentId: ENVIRONMENT_ID,
    }),
  ];
  state.finish.mockReset();
  state.finish.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  useRightPanelStore.setState({ byThreadKey: {} });
}

function CloseTab(props: { readonly surface: RightPanelSurface }) {
  const { closeSurface } = useRightPanelSurfaceClose({
    threadRef: LESSON_REF,
    terminalLabelsById: new Map(),
  });
  return (
    <button type="button" onClick={() => closeSurface(props.surface)}>
      Close tab
    </button>
  );
}

it("forgets the draft of an empty side chat that closing its tab deletes", async () => {
  setup();
  useRightPanelStore
    .getState()
    .openLessonSideChat(LESSON_REF, { topThreadId: "side-1", threadId: "side-1" });
  useComposerDraftStore.getState().setPrompt(SIDE_REF, "And the reward?");
  useComposerDraftStore
    .getState()
    .setModelSelection(SIDE_REF, createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5"));
  await using screen = await render(
    <CloseTab surface={{ id: "side-chat:side-1", kind: "lesson-side-chat", threadId: "side-1" }} />,
  );

  await screen.getByRole("button", { name: "Close tab" }).click();

  expect(state.finish).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: "side-1" },
  });
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(SIDE_REF)).toBeNull(),
  );
});

it("does not finish a side chat when an upstream side-chat tab closes", async () => {
  setup();
  const surface: RightPanelSurface = {
    id: "side-chat:side-1",
    kind: "side-chat",
    threadId: SIDE_REF.threadId,
  };
  await using screen = await render(<CloseTab surface={surface} />);

  await screen.getByRole("button", { name: "Close tab" }).click();

  expect(state.finish).not.toHaveBeenCalled();
});
