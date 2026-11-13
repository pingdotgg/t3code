import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";

const terminalLabels = vi.hoisted(() => ({ byThreadId: new Map<string, string>() }));

vi.mock(import("~/state/terminalSessions"), async (original) => ({
  ...(await original()),
  useTerminalLabelsByThreadKey: (environmentIds) =>
    new Map(
      environmentIds.flatMap((environmentId) =>
        [...terminalLabels.byThreadId].map(
          ([threadId, label]) => [`${environmentId}:${threadId}`, label] as const,
        ),
      ),
    ),
}));

import { act, render } from "../../../test/render";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { SidebarDraftBlock } from "./SidebarDraftBlock";

function setup(labels: Record<string, string> = {}) {
  terminalLabels.byThreadId = new Map(Object.entries(labels));
}

function draftBlock(routeDraftId: string | null) {
  return (
    <ul>
      <SidebarDraftBlock
        projectByKey={new Map()}
        projectDisplayNameByKey={new Map()}
        scopedProjectKeys={null}
        routeDraftId={routeDraftId}
        onNavigateToDraft={vi.fn()}
        onDraftContextMenu={vi.fn()}
      />
    </ul>
  );
}

it("keeps draft previews current through edits, promotion and removal", async () => {
  setup();
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const environmentId = EnvironmentId.make("draft-preview-environment");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("draft-preview-project"));
  const draftId = DraftId.make("draft-preview");
  const threadId = ThreadId.make("draft-preview-thread");
  const onRender = vi.fn();
  await using screen = await render(
    <Profiler id="draft-block" onRender={onRender}>
      {draftBlock(null)}
    </Profiler>,
  );
  const row = screen.getByTestId("sidebar-draft-row");
  await expect.element(row).not.toBeInTheDocument();

  await act(() => {
    initial.setProjectDraftThreadId(projectRef, draftId, { threadId });
    initial.setPrompt(draftId, "First draft preview");
  });
  await expect.element(row).toHaveAccessibleName("First draft preview, Unsent draft");

  const rendersBeforeOtherComposer = onRender.mock.calls.length;
  await act(() =>
    initial.setPrompt(scopeThreadRef(environmentId, ThreadId.make("other")), "Other composer"),
  );
  expect(onRender).toHaveBeenCalledTimes(rendersBeforeOtherComposer);
  await act(() => initial.setPrompt(draftId, "Updated draft preview"));
  await expect.element(row).toHaveAccessibleName("Updated draft preview, Unsent draft");

  const quote = "Cache the parsed config per worktree.";
  const citation = formatAssistantCitationForComposer({
    version: 1,
    environmentId,
    threadId: ThreadId.make("source-thread"),
    messageId: MessageId.make("source-message"),
    text: quote,
    start: 0,
    end: quote.length,
    prefix: "",
    suffix: "",
  });
  await act(() => initial.setPrompt(draftId, `${citation}Why per worktree?`));
  await expect.element(row).toHaveAccessibleName(`${quote} Why per worktree?, Unsent draft`);

  await act(() => initial.markDraftThreadPromoting(draftId));
  await expect.element(row).not.toBeInTheDocument();
  await act(() => initial.clearDraftThread(draftId));

  const nextDraftId = DraftId.make("next-draft-preview");
  await act(() => {
    initial.setProjectDraftThreadId(projectRef, nextDraftId, { threadId: ThreadId.make("next") });
    initial.setPrompt(nextDraftId, "Next draft preview");
  });
  await expect.element(row).toHaveAccessibleName("Next draft preview, Unsent draft");
  await act(() => initial.clearDraftThread(nextDraftId));
  await expect.element(row).not.toBeInTheDocument();
});

it("lists empty drafts by terminal label while their terminal exists, active or not", async () => {
  setup({ "terminal-thread": "dev" });
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const environmentId = EnvironmentId.make("draft-terminal-environment");
  const terminalDraftId = DraftId.make("draft-with-terminal");
  initial.setProjectDraftThreadId(
    scopeProjectRef(environmentId, ProjectId.make("terminal-project")),
    terminalDraftId,
    { threadId: ThreadId.make("terminal-thread") },
  );
  initial.setProjectDraftThreadId(
    scopeProjectRef(environmentId, ProjectId.make("idle-project")),
    DraftId.make("draft-without-terminal"),
    { threadId: ThreadId.make("idle-thread") },
  );

  await using screen = await render(draftBlock(terminalDraftId));
  const rows = screen.getByTestId("sidebar-draft-row");
  await expect.element(rows).toHaveAccessibleName("dev, Unsent draft");
  expect(rows.elements()).toHaveLength(1);

  await screen.rerender(draftBlock(null));
  await expect.element(rows).toHaveAccessibleName("dev, Unsent draft");
  expect(rows.elements()).toHaveLength(1);
});
