import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ note: undefined as string | undefined, saves: 0 }));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => ({
    projection: { thread: persisted.note === undefined ? {} : { note: persisted.note } },
  })) as never,
}));
vi.mock(import("~/state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { note: string | null } }) => {
      persisted.saves += 1;
      persisted.note = input.note ?? undefined;
      return { _tag: "Success" };
    }) as never,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { openThreadNote, ThreadNoteButton } from "./ThreadNoteButton";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

function noteButton() {
  return (
    <AppAtomRegistryProvider>
      <ThreadNoteButton threadRef={threadRef} canEdit />
      <div tabIndex={0} style={{ marginTop: 600 }}>
        Outside note
      </div>
    </AppAtomRegistryProvider>
  );
}

it("keeps a note saved on click-away and drops an edit cancelled with Escape", async () => {
  persisted.note = undefined;
  persisted.saves = 0;
  await using screen = await render(noteButton());

  await screen.getByRole("button", { name: "Thread note" }).click();
  await page.getByRole("textbox", { name: "Thread note" }).fill("Check the login redirect");
  await screen.getByText("Outside note").click();
  await expect.element(page.getByRole("textbox", { name: "Thread note" })).not.toBeInTheDocument();
  expect(persisted.note).toBe("Check the login redirect");

  await screen.rerender(noteButton());
  await screen.getByRole("button", { name: "Thread note (has note)" }).click();
  const textarea = page.getByRole("textbox", { name: "Thread note" });
  await expect.element(textarea).toHaveValue("Check the login redirect");

  await textarea.fill("Discard me");
  await userEvent.keyboard("{Escape}");
  await expect.element(textarea).not.toBeInTheDocument();
  expect(persisted.note).toBe("Check the login redirect");
  expect(persisted.saves).toBe(1);

  // The command palette opens the popover without going through the trigger.
  await act(() => openThreadNote(threadRef));
  await expect
    .element(page.getByRole("textbox", { name: "Thread note" }))
    .toHaveValue("Check the login redirect");
});
