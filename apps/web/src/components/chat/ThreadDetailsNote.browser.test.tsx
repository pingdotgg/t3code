import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({
  saves: [] as Array<{ threadId: string; note: string | null }>,
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => ({ projection: { thread: { note: "First line" } } })) as never,
}));
vi.mock(import("~/state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { threadId: string; note: string | null } }) => {
      persisted.saves.push(input);
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import { ThreadDetailsNote } from "./ThreadDetailsNote";

const environmentId = EnvironmentId.make("environment");

function panel(threadId: string) {
  return (
    <AppAtomRegistryProvider>
      <ThreadDetailsNote
        key={threadId}
        threadRef={{ environmentId, threadId: ThreadId.make(threadId) }}
      />
    </AppAtomRegistryProvider>
  );
}

it("keeps Escape inside the panel and saves an open edit when the thread changes", async () => {
  persisted.saves = [];
  const escapesReachingDocument = vi.fn();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") escapesReachingDocument();
  });
  await using screen = await render(panel("thread-a"));
  const textarea = page.getByRole("textbox", { name: "Thread note" });

  await screen.getByRole("button", { name: /Edit thread note/ }).click();
  await textarea.fill("Discard me");
  await userEvent.keyboard("{Escape}");
  await expect.element(textarea).not.toBeInTheDocument();
  expect(escapesReachingDocument).not.toHaveBeenCalled();
  expect(persisted.saves).toEqual([]);

  // Switching threads unmounts the editor without a blur; the edit still lands on its own thread.
  await screen.getByRole("button", { name: /Edit thread note/ }).click();
  await textarea.fill("Belongs to A");
  await screen.rerender(panel("thread-b"));
  await expect.element(textarea).not.toBeInTheDocument();
  expect(persisted.saves).toEqual([{ threadId: "thread-a", note: "Belongs to A" }]);
});
