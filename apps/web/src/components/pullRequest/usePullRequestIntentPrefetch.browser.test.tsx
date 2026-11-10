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
      activity: ((target: unknown) => ({ activity: target })) as never,
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

function Rows() {
  const prefetch = usePullRequestIntentPrefetch(() => true);
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

it("reads the panel's detail and activity once intent rests on a row for 150 ms", async () => {
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
  // Query atoms key on JSON order: this is the order the PRs page panel reads.
  const reference = {
    projectId: row.projectId,
    repository: "owner/repo",
    number: 7,
    host: "github.com",
  };
  expect(state.reads.slice(-2).map((read) => JSON.stringify(read))).toEqual([
    JSON.stringify({ environmentId, input: { ...reference, allowStale: false } }),
    JSON.stringify({ activity: { environmentId, input: reference } }),
  ]);

  await act(() => leave.click());
  expect(state.reads.slice(-2)).toEqual([null, null]);
});
