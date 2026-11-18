import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({
  note: "First line",
  defer: false,
  pending: undefined as ((result: AtomCommandResult<void, Error>) => void) | undefined,
  saves: [] as Array<{ threadId: string; note: string | null }>,
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => ({ projection: { thread: { note: persisted.note } } })) as never,
}));
vi.mock(import("~/state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { threadId: string; note: string | null } }) => {
      persisted.saves.push(input);
      if (persisted.defer)
        return new Promise<AtomCommandResult<void, Error>>((resolve) => {
          persisted.pending = resolve;
        });
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { ThreadDetailsNote } from "./ThreadDetailsNote";

const environmentId = EnvironmentId.make("environment");

function setup() {
  persisted.note = "First line";
  persisted.defer = false;
  persisted.pending = undefined;
  persisted.saves = [];
}

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
  setup();
  const escapesReachingDocument = vi.fn();
  await using screen = await render(panel("thread-a"));
  const controller = new AbortController();
  using _listener = { [Symbol.dispose]: () => controller.abort() };
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") escapesReachingDocument();
    },
    { signal: controller.signal },
  );
  const textarea = page.getByRole("textbox", { name: "Thread note" });

  await screen.getByRole("button", { name: /Edit thread note/ }).click();
  await textarea.fill("Discard me");
  await userEvent.keyboard("{Escape}");
  await expect.element(textarea).not.toBeInTheDocument();
  expect(escapesReachingDocument).not.toHaveBeenCalled();
  expect(persisted.saves).toEqual([]);

  await screen.getByRole("button", { name: /Edit thread note/ }).click();
  persisted.note = "Changed on another device";
  await screen.rerender(panel("thread-a"));
  await textarea.element().blur();
  expect(persisted.saves).toEqual([]);

  // Switching threads unmounts the editor without a blur; the edit still lands on its own thread.
  await screen.getByRole("button", { name: /Edit thread note/ }).click();
  await textarea.fill("Belongs to A");
  await screen.rerender(panel("thread-b"));
  await expect.element(textarea).not.toBeInTheDocument();
  expect(persisted.saves).toEqual([{ threadId: "thread-a", note: "Belongs to A" }]);
  using _windowBlur = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await screen.getByRole("button", { name: /Edit thread note/ }).click();
  await textarea.fill("Submitted B");
  persisted.defer = true;
  await textarea.element().blur();
  await vi.waitFor(() => expect(persisted.pending).toBeDefined());
  await textarea.fill("Newer C");
  await act(() => persisted.pending?.(AsyncResult.failure(Cause.fail(new Error("Save failed")))));
  await expect.element(textarea).toHaveValue("Newer C");

  persisted.pending = undefined;
  await textarea.element().blur();
  await vi.waitFor(() => expect(persisted.pending).toBeDefined());
  await act(() => persisted.pending?.(AsyncResult.failure(Cause.fail(new Error("Save failed")))));
  await expect.element(textarea).toHaveValue("Newer C");
  persisted.defer = false;
  await screen.rerender(panel("thread-c"));
  expect(persisted.saves.at(-1)).toEqual({ threadId: "thread-b", note: "Newer C" });
});
