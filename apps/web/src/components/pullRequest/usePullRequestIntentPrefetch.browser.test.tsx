import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ reads: [] as Array<unknown> }));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: ((target: unknown) => target) as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((target: unknown) => {
    if (target !== null || state.reads.length > 0) state.reads.push(target);
    return {};
  }) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { usePullRequestIntentPrefetch } from "./usePullRequestIntentPrefetch";

const environmentId = EnvironmentId.make("environment");
const row = {
  environmentId,
  projectId: ProjectId.make("project"),
  host: "GitHub.com",
  repository: "owner/repo",
  number: 7,
};

function Rows({ listed = true }: { listed?: boolean }) {
  const prefetch = usePullRequestIntentPrefetch(() => listed);
  return (
    <>
      <button type="button" onClick={() => prefetch(row)}>
        rest
      </button>
      <button type="button" onClick={() => prefetch(null)}>
        leave
      </button>
    </>
  );
}

it("reads the panel's detail only while the pointer rests on a listed row", async () => {
  state.reads = [];
  await using screen = await render(<Rows />, {
    // A bare hook probe; nothing here navigates.
    router: false,
  });
  using _timers = fakeTimers({ now: 0 });
  const rest = screen.getByRole("button", { name: "rest" }).element() as HTMLElement;
  const leave = screen.getByRole("button", { name: "leave" }).element() as HTMLElement;

  await act(() => {
    rest.click();
    leave.click();
  });
  await act(() => vi.advanceTimersByTime(1_000));
  expect(state.reads).toEqual([]);

  await act(() => rest.click());
  await act(() => vi.advanceTimersByTime(149));
  expect(state.reads).toEqual([]);
  await act(() => vi.advanceTimersByTime(1));
  expect(state.reads.at(-1)).toEqual({
    environmentId,
    input: {
      projectId: row.projectId,
      host: "github.com",
      repository: "owner/repo",
      number: 7,
      allowStale: false,
    },
  });

  await act(() => leave.click());
  expect(state.reads.at(-1)).toBeNull();

  await act(() => rest.click());
  await act(() => vi.advanceTimersByTime(150));
  expect(state.reads.at(-1)).not.toBeNull();
  // A row removed from the list fires no leave event, and coming back is not new intent.
  let removedAt = state.reads.length;
  await screen.rerender(<Rows listed={false} />);
  await screen.rerender(<Rows listed />);
  expect(state.reads.slice(removedAt)).not.toContainEqual(expect.anything());

  await act(() => rest.click());
  await act(() => vi.advanceTimersByTime(100));
  removedAt = state.reads.length;
  await screen.rerender(<Rows listed={false} />);
  await screen.rerender(<Rows listed />);
  await act(() => vi.advanceTimersByTime(1_000));
  expect(state.reads.slice(removedAt)).not.toContainEqual(expect.anything());
});
