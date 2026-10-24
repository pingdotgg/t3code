import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import {
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { useQueuedRunEdit } from "./useQueuedRunEdit";

const commands = vi.hoisted(() => ({
  save: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => commands.save) as never,
}));
vi.mock(import("../../assets/assetUrls"), () => ({ useAssetUrls: () => [] }));

function Editor({ text = "Original message" }: { readonly text?: string }) {
  const environmentId = EnvironmentId.make("environment:queue-edit");
  const threadId = ThreadId.make("thread:queue-edit");
  const threadRef = scopeThreadRef(environmentId, threadId);
  const promptRef = useRef("");
  const edit = useQueuedRunEdit({
    environmentId,
    routeThreadRef: threadRef,
    threadDraftTarget: threadRef,
    activeThreadId: threadId,
    serverProjection: null,
    promptRef,
    composerRef: { current: null },
  });
  const draft = useComposerThreadDraft(edit.draftTarget);
  return (
    <>
      <button
        onClick={() =>
          edit.beginEdit({
            runId: RunId.make("run:queued"),
            messageId: MessageId.make("message:queued"),
            text,
            attachments: [
              {
                type: "file",
                id: "file:report",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 6,
              },
            ],
          })
        }
      >
        Edit queued message
      </button>
      <textarea
        aria-label="Message"
        value={draft.prompt}
        onChange={(event) =>
          useComposerDraftStore.getState().setPrompt(edit.draftTarget, event.target.value)
        }
      />
      {edit.editingAttachments?.map(({ attachment }) => (
        <button key={attachment.id} onClick={() => edit.removeEditingAttachment(attachment.id)}>
          Remove {attachment.name}
        </button>
      ))}
      <button onClick={edit.cancelEdit}>Cancel edit</button>
      <button onClick={() => edit.saveEdit(draft, () => undefined)}>Save edit</button>
    </>
  );
}

it.each(["Updated message", ""])(
  "restores the unsaved edit %j and attachment removals after leaving the thread",
  async (text) => {
    commands.save.mockClear();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    await using screen = await render(<Editor />, { router: false });
    await screen.getByRole("textbox", { name: "Message" }).fill("Separate draft");
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await screen.getByRole("textbox", { name: "Message" }).fill(text);
    await screen.getByRole("button", { name: "Remove report.pdf" }).click();
    await screen.rerender(<div>Another thread</div>);
    const persisted = JSON.parse(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    );
    useComposerDraftStore.setState(
      useComposerDraftStore.persist.getOptions().merge!(
        persisted,
        useComposerDraftStore.getInitialState(),
      ),
    );
    await screen.rerender(<Editor />);
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text);
    await expect
      .element(screen.getByRole("button", { name: "Remove report.pdf" }))
      .not.toBeInTheDocument();
    if (text) {
      await screen.getByRole("button", { name: "Save edit" }).click();
      await vi.waitFor(() =>
        expect(commands.save).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              text,
              edit: expect.objectContaining({ attachments: [] }),
            }),
          }),
        ),
      );
    } else {
      await screen.getByRole("button", { name: "Cancel edit" }).click();
    }
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Separate draft");
    await screen.getByRole("button", { name: "Edit queued message" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Original message");
    await expect.element(screen.getByRole("button", { name: "Remove report.pdf" })).toBeVisible();
  },
);

it("reopens an untouched edit with the queued message saved by another client", async () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  await using screen = await render(<Editor />, { router: false });
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await screen.rerender(<div>Another thread</div>);
  await screen.rerender(<Editor text="Updated message" />);
  await screen.getByRole("button", { name: "Edit queued message" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Updated message");
});
