import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarProjectFolderHeader } from "./SidebarProjectFolderHeader";

const environmentId = EnvironmentId.make("folder-dot-environment");
const COMPLETED_AT = "2026-03-09T10:05:00.000Z";
const BEFORE_COMPLETION = "2026-03-09T10:04:00.000Z";
const AFTER_COMPLETION = "2026-03-09T10:06:00.000Z";

function makeFolderFixture(index: number) {
  const projectId = ProjectId.make(`folder-project-${index}`);
  const group = {
    environmentId,
    workspaceRoot: `/repo-${index}`,
    title: `Project ${index}`,
    faviconPath: null,
    projectIcon: null,
    projectKey: `folder-${index}`,
    displayName: `Project ${index}`,
  } as SidebarProjectSnapshot;
  // No server lastVisitedAt, as from an older server, so the dot reads local visits.
  const thread = makeThreadFixture({
    environmentId,
    id: ThreadId.make(`folder-thread-${index}`),
    projectId,
    runtime: null,
    latestRun: {
      runId: RunId.make(`folder-run-${index}`),
      status: "completed",
      assistantMessageId: null,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: COMPLETED_AT,
    },
  });
  return { group, thread };
}

const threadKey = (thread: { environmentId: EnvironmentId; id: ThreadId }) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

it("re-renders a folder header only when a visit changes its dot", async () => {
  const initial = useUiStateStore.getState();
  using _store = {
    [Symbol.dispose]: () => useUiStateStore.setState(initial, true),
  };
  const [unread, seen] = [makeFolderFixture(0), makeFolderFixture(1)];
  useUiStateStore.setState({
    threadLastVisitedAtById: {
      [threadKey(unread.thread)]: BEFORE_COMPLETION,
      [threadKey(seen.thread)]: AFTER_COMPLETION,
    },
  });
  const renders = new Map<string, number>();
  const onRender = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
  await using screen = await render(
    <ul>
      {[unread, seen].map(({ group, thread }) => (
        <Profiler key={group.projectKey} id={group.projectKey} onRender={onRender}>
          <SidebarProjectFolderHeader
            group={group}
            collapsed
            hiddenThreads={[thread]}
            onToggle={vi.fn()}
            onNewThread={vi.fn()}
            onContextMenu={vi.fn()}
          />
        </Profiler>
      ))}
    </ul>,
  );
  const header = (index: number) =>
    screen.getByRole("treeitem", { name: new RegExp(`^Project ${index}`) });
  await expect.element(header(0)).toHaveAccessibleName(/, done/);
  await expect.element(header(1)).not.toHaveAccessibleName(/, done/);

  renders.clear();
  const elsewhere = threadKey({ environmentId, id: ThreadId.make("elsewhere") });
  await act(() => initial.markThreadVisited(elsewhere, "2026-03-09T11:00:00.000Z"));
  expect(renders.size).toBe(0);

  await act(() => initial.markThreadVisited(threadKey(unread.thread), AFTER_COMPLETION));
  await expect.element(header(0)).not.toHaveAccessibleName(/, done/);
  await act(() => initial.markThreadUnread(threadKey(seen.thread), COMPLETED_AT));
  await expect.element(header(1)).toHaveAccessibleName(/, done/);
  expect(Object.fromEntries(renders)).toEqual({ "folder-0": 1, "folder-1": 1 });
});
