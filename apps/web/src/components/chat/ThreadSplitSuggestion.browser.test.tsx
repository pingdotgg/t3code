import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, fakeTimers, render } from "../../../test/render";

type Draft = { prompt: string; hasContext: boolean };
const state = vi.hoisted(() => ({
  source: { prompt: "", hasContext: false } as Draft,
  destination: { prompt: "", hasContext: false } as Draft,
  enabled: false,
  suggest: vi.fn(),
  open: vi.fn(),
  toast: vi.fn(),
}));
vi.mock(import("@effect/atom-react"), () => ({ useAtomValue: () => true }) as never);
vi.mock(
  import("../../state/threads"),
  () => ({ threadEnvironment: { suggestSplit: { permissionAtom: () => true } } }) as never,
);
vi.mock(
  import("../../hooks/useSettings"),
  () =>
    ({
      useEnvironmentSettings: () => ({
        threadSplitSuggestionsEnabled: state.enabled,
        threadSplitModelEndpoint: "http://127.0.0.1:8080",
      }),
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => state.suggest }) as never,
);
vi.mock(
  import("../../hooks/useHandleNewThread"),
  () => ({ useNewThreadHandler: () => state.open }) as never,
);
vi.mock(import("../ui/toastManager"), () => ({ toastManager: { add: state.toast } }) as never);
vi.mock(import("../../composerDraftStore"), () => {
  const store = {
    getComposerDraft: (target: unknown) =>
      typeof target === "string" ? state.destination : state.source,
    setPrompt: (_target: unknown, prompt: string) => {
      state.source.prompt = prompt;
    },
  };
  return {
    DraftId: { make: (value: string) => value },
    useComposerDraftStore: Object.assign(
      (selector: (value: typeof store) => unknown) => selector(store),
      { getState: () => store },
    ),
    composerDraftHasUserContent: (draft: Draft) => Boolean(draft.prompt) || draft.hasContext,
  } as never;
});

import { ThreadSplitSuggestion } from "./ThreadSplitSuggestion";

function setup() {
  state.source = { prompt: "A new task", hasContext: false };
  state.destination = { prompt: "", hasContext: false };
  state.enabled = false;
  state.suggest.mockReset();
  state.open.mockReset();
  state.toast.mockReset();
  const threadRef = {
    environmentId: EnvironmentId.make("environment-test"),
    threadId: ThreadId.make("thread-test"),
  };
  return (key = "initial") => (
    <ThreadSplitSuggestion
      key={key}
      threadRef={threadRef}
      projectId={ProjectId.make("project-test")}
      idle
    />
  );
}

it("discards stale replies, supports opt-out and dismissal that outlasts edits, and preserves concurrent draft edits during explicit transfer", async () => {
  const view = setup();
  await using screen = await render(view());
  using _timers = fakeTimers();
  const replies: Array<
    (value: ReturnType<typeof AsyncResult.success<{ suggest: boolean }>>) => void
  > = [];
  state.suggest.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  const action = screen.getByRole("button", { name: "Start a new thread with this draft" });
  state.enabled = true;
  await screen.rerender(view());
  await act(() => vi.advanceTimersByTime(1000));
  expect(replies).toHaveLength(1);
  state.source.prompt = "Edited task";
  await screen.rerender(view());
  await act(() => replies.shift()!(AsyncResult.success({ suggest: true })));
  await expect.element(action).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(1000));
  state.enabled = false;
  await screen.rerender(view());
  await act(() => replies.shift()!(AsyncResult.success({ suggest: true })));
  await expect.element(action).not.toBeInTheDocument();
  state.enabled = true;
  await screen.rerender(view());
  await act(() => vi.advanceTimersByTime(1000));
  await act(() => replies.shift()!(AsyncResult.success({ suggest: true })));
  await expect.element(action).toBeVisible();
  expect(state.open).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Dismiss new thread suggestion" }).click();
  await expect.element(action).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(1000));
  expect(replies).toHaveLength(0);
  state.source.prompt = "A new task, continued in this thread";
  await screen.rerender(view());
  await act(() => vi.advanceTimersByTime(1000));
  expect(replies).toHaveLength(0);
  await screen.rerender(view("remounted"));
  await act(() => vi.advanceTimersByTime(1000));
  expect(replies).toHaveLength(0);
  await expect.element(action).not.toBeInTheDocument();
  state.source.prompt = "";
  await screen.rerender(view());

  state.source.prompt = "Another task";
  await screen.rerender(view());
  await act(() => vi.advanceTimersByTime(1000));
  await act(() => replies.shift()!(AsyncResult.success({ suggest: true })));
  let finishOpen!: (value: { draftId: string; threadId: string }) => void;
  state.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
  );
  await action.click();
  expect(state.open).toHaveBeenCalledWith(
    { environmentId: "environment-test", projectId: "project-test" },
    { prompt: "Another task" },
  );
  state.destination.prompt = "Another task";
  state.source.prompt = "An edit made during navigation";
  await act(() => finishOpen({ draftId: "draft-new", threadId: "thread-new" }));
  expect(state.source.prompt).toBe("An edit made during navigation");

  await screen.rerender(view());
  await act(() => vi.advanceTimersByTime(1000));
  await act(() => replies.shift()!(AsyncResult.success({ suggest: true })));
  await action.click();
  state.destination.prompt = state.source.prompt;
  await act(() => finishOpen({ draftId: "draft-next", threadId: "thread-next" }));
  expect(state.source.prompt).toBe("");
  expect(state.destination.prompt).toBe("An edit made during navigation");
});
