import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { SidebarDraftBlock } from "./SidebarDraftBlock";

it("keeps draft previews current through edits, promotion and removal", async () => {
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
      <ul>
        <SidebarDraftBlock
          section="drafts"
          snoozeNowMs={0}
          timestampFormat="locale"
          onSnoozeDraft={vi.fn()}
          onUnsnoozeDraft={vi.fn()}
          projectByKey={new Map()}
          projectDisplayNameByKey={new Map()}
          scopedProjectKeys={null}
          routeDraftId={null}
          onNavigateToDraft={vi.fn()}
          onDraftContextMenu={vi.fn()}
        />
      </ul>
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

it("moves a snoozed draft to the Snoozed shelf until it wakes", async () => {
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const projectRef = scopeProjectRef(
    EnvironmentId.make("draft-snooze-environment"),
    ProjectId.make("draft-snooze-project"),
  );
  const draftId = DraftId.make("draft-snooze");
  initial.setProjectDraftThreadId(projectRef, draftId, { threadId: ThreadId.make("snooze") });
  initial.setPrompt(draftId, "Later");
  // Before the real clock, so the menu's presets, read live, land after it.
  const nowMs = Date.parse("2026-01-01T09:00:00.000Z");
  const onSnoozeDraft = (id: DraftId, preset: { snoozedUntil: string }) =>
    useComposerDraftStore.getState().setDraftSnoozedUntil(id, preset.snoozedUntil);
  const onUnsnoozeDraft = (id: DraftId) =>
    useComposerDraftStore.getState().setDraftSnoozedUntil(id, null);
  const tree = (snoozeNowMs: number) => (
    <>
      {(["drafts", "snoozed"] as const).map((section) => (
        <ul key={section} data-testid={section}>
          <SidebarDraftBlock
            section={section}
            snoozeNowMs={snoozeNowMs}
            timestampFormat="locale"
            onSnoozeDraft={onSnoozeDraft}
            onUnsnoozeDraft={onUnsnoozeDraft}
            projectByKey={new Map()}
            projectDisplayNameByKey={new Map()}
            scopedProjectKeys={null}
            routeDraftId={null}
            onNavigateToDraft={vi.fn()}
            onDraftContextMenu={vi.fn()}
          />
        </ul>
      ))}
    </>
  );
  await using screen = await render(tree(nowMs));
  const draftRow = screen.getByTestId("drafts").getByTestId("sidebar-draft-row");
  const snoozedRow = screen.getByTestId("snoozed").getByTestId("sidebar-draft-row");

  await userEvent.hover(draftRow);
  await userEvent.click(draftRow.getByRole("button", { name: "Snooze draft" }));
  await userEvent.click(page.getByRole("menuitem").first());
  await expect.element(draftRow).not.toBeInTheDocument();
  await expect.element(snoozedRow).toHaveAccessibleName("Later, Snoozed draft");

  await userEvent.hover(snoozedRow);
  await userEvent.click(snoozedRow.getByRole("button", { name: "Wake draft now" }));
  await expect.element(snoozedRow).not.toBeInTheDocument();
  await expect.element(draftRow).toHaveAccessibleName("Later, Unsent draft");

  const wakeAt = nowMs + 60 * 60_000;
  await act(() => initial.setDraftSnoozedUntil(draftId, new Date(wakeAt).toISOString()));
  await expect.element(snoozedRow).toBeInTheDocument();
  await screen.rerender(tree(wakeAt));
  await expect.element(snoozedRow).not.toBeInTheDocument();
  await expect.element(draftRow).toHaveAccessibleName("Later, Unsent draft");
});
