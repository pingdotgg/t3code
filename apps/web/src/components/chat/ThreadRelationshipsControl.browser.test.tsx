import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  NodeId,
  ThreadId,
  type OrchestrationV2PreviousAgentsPage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

class HistoryQueryFailed extends Schema.TaggedError<HistoryQueryFailed>()("HistoryQueryFailed", {
  cause: Schema.Defect(),
}) {}

const state = vi.hoisted(() => ({
  projection: null as unknown,
  commandSucceeds: false,
  relatedShells: [] as unknown[],
  threadTitles: {} as Record<string, string>,
  archivedThreads: [] as unknown[],
  historyQuery: Symbol("history"),
  refreshHistory: () => {},
  controlledHistory: false,
  historyAtoms: new Map<
    string,
    Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2PreviousAgentsPage, HistoryQueryFailed>>
  >(),
  historyRequests: [] as Array<{
    key: string;
    limit: number;
    resolve: (page: OrchestrationV2PreviousAgentsPage) => void;
    reject: (error: Error) => void;
  }>,
}));

vi.mock(import("../../state/orchestration"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    orchestrationEnvironment: {
      ...actual.orchestrationEnvironment,
      previousAgents: ((target: {
        environmentId: string;
        input: { threadId: string; limit: number };
      }) => {
        if (!state.controlledHistory) return state.historyQuery;
        const key = JSON.stringify([
          target.environmentId,
          target.input.threadId,
          target.input.limit,
        ]);
        let atom = state.historyAtoms.get(key);
        if (!atom) {
          atom = Atom.make(
            Effect.tryPromise({
              try: () =>
                new Promise<OrchestrationV2PreviousAgentsPage>((resolve, reject) => {
                  state.historyRequests.push({ key, limit: target.input.limit, resolve, reject });
                }),
              catch: (cause) => new HistoryQueryFailed({ cause }),
            }),
          ).pipe(Atom.setIdleTTL(0));
          state.historyAtoms.set(key, atom);
        }
        return atom;
      }) as never,
    },
  };
});

vi.mock(import("../../state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: ((atom: unknown) => {
      if ([...state.historyAtoms.values()].includes(atom as never))
        return actual.useEnvironmentQuery(atom as never);
      return {
        data: atom === state.historyQuery || atom === null ? null : state.threadTitles,
        isSuccess: atom !== null && atom !== state.historyQuery,
        isPending: false,
        error: null,
        refresh: state.refreshHistory,
      };
    }) as never,
  };
});

vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: unknown) =>
      [...state.historyAtoms.values()].includes(atom as never)
        ? actual.useAtomValue(atom as never)
        : false) as never,
  };
});

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: (() => null) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
  useThreadRelationshipShells: (() =>
    state.projection === null
      ? []
      : [(state.projection as { thread: unknown }).thread, ...state.relatedShells]) as never,
  useProjects: (() => []) as never,
  useHiddenThreadKeys: (() => new Set()) as never,
  useAnyEnvironmentHiding: (() => false) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => ({
    snapshots: [{ environmentId: "environment", snapshot: { threads: state.archivedThreads } }],
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () =>
    state.commandSucceeds
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(Cause.fail(new Error("Connection lost")))) as never,
}));

import { act, render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ToastProvider } from "../ui/toast";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("fork");

function setup() {
  state.controlledHistory = false;
  state.historyAtoms.clear();
  state.historyRequests = [];
  state.commandSucceeds = false;
  state.relatedShells = [];
  state.threadTitles = { source: "Source" };
  state.archivedThreads = [];
  state.projection = {
    thread: {
      id: threadId,
      title: "Fork",
      activeProviderThreadId: null,
      lineage: { parentThreadId: ThreadId.make("source"), relationshipToParent: "fork" },
      forkedFrom: null,
    },
    runs: [{ id: "run", ordinal: 1, status: "completed" }],
    subagents: [],
    contextTransfers: [],
    providerThreads: [],
    providerSessions: [{ id: "session", status: "ready" }],
  };
}

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("reports a rejected %s command and clears the busy state", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
  );

  if (action === "merge") {
    await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
  } else {
    await screen.getByRole("button", { name: "More thread actions" }).click();
    await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
  }

  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  await expect
    .element(
      screen.getByRole("button", {
        name: action === "merge" ? "Merge back to source conversation" : "More thread actions",
      }),
    )
    .toBeEnabled();
});

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("clears the previous %s error after a successful retry", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
    { router: "/environment/fork" },
  );

  const runAction = async () => {
    if (action === "merge") {
      await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
    } else {
      await screen.getByRole("button", { name: "More thread actions" }).click();
      await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
    }
  };

  await runAction();
  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");

  state.commandSucceeds = true;
  await runAction();

  await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe(
      action === "merge" ? "/environment/source" : "/environment/fork",
    );
  });
  if (action === "disconnect") {
    await expect.element(screen.getByRole("button", { name: "More thread actions" })).toBeEnabled();
  }
});

it("opens an idle child from Lineage when its shell has not been loaded", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  const childId = ThreadId.make("omitted-child");
  const environmentId = EnvironmentId.make("local");
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("agent"),
        threadId: projection.thread.id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Inspect the change",
        title: "Idle child",
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: projection.thread.updatedAt,
        updatedAt: projection.thread.updatedAt,
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const child = screen.getByRole("button", { name: /Idle child/ });
  await expect.element(child).toBeEnabled();
  await child.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/local/omitted-child"),
  );
});

it("shows a lineage thread's full title in its tooltip", async () => {
  setup();
  const longTitle = "Compare the lineage tooltip against a title that the row truncates";
  const sourceThread = {
    ...(state.projection as { thread: Record<string, unknown> }).thread,
    id: "source",
    title: longTitle,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  state.relatedShells = [sourceThread];
  await using _screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
  );

  await userEvent.hover(page.getByText(longTitle, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
});

it("shows a side chat's full title in its tooltip", async () => {
  setup();
  const longTitle = "Side chat question with a title that the side chat row truncates";
  state.relatedShells = [
    {
      id: "side",
      title: longTitle,
      lineage: {
        parentThreadId: threadId,
        relationshipToParent: "fork",
        rootThreadId: threadId,
        sideChat: true,
      },
    },
  ];
  await using _screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage={false}
      showSideChats
    />,
  );

  await userEvent.hover(page.getByText(longTitle, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
});

it("shows a remote subagent's full title in its tooltip even when its environment is unavailable", async () => {
  setup();
  const longTitle = "Investigate a remote subagent issue across linked environments";
  const remoteEnvId = EnvironmentId.make("remote-env");
  const remoteThreadId = ThreadId.make("remote-thread");
  const now = DateTime.makeUnsafe("2026-10-31T20:00:00.000Z");
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    subagents: [
      {
        id: NodeId.make("remote-agent"),
        threadId,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: "provider",
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Run remote task",
        title: longTitle,
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        remoteChild: {
          environmentId: remoteEnvId,
          threadId: remoteThreadId,
          label: "Remote VM with a long machine name in the office",
        },
      },
    ],
  };
  await using screen = await render(
    <div style={{ width: 320 }}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats={false}
      />
    </div>,
    { router: "/environment/fork" },
  );

  // A finished remote task sits with the other finished agents, not in its own list.
  await expect
    .element(screen.getByRole("button", { name: new RegExp(longTitle) }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const row = screen.getByRole("button", { name: new RegExp(longTitle) });
  // A long environment label must not squeeze the title out of the row.
  expect(
    page.getByText(longTitle, { exact: true }).element().getBoundingClientRect().width,
  ).toBeGreaterThan(0);
  await userEvent.hover(row);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Runs on Remote VM with a long machine name in the office. Connect to it to open the thread there.",
  );

  await row.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("shows a delegated-from thread's full title in its tooltip even when its environment is unavailable", async () => {
  setup();
  const longTitle = "Parent task delegated from another machine that has a long description";
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    thread: {
      ...(state.projection as { thread: Record<string, unknown> }).thread,
      delegatedFrom: {
        environmentId: EnvironmentId.make("parent-env"),
        threadId: ThreadId.make("parent-thread"),
        title: longTitle,
      },
    },
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
    { router: "/environment/fork" },
  );

  const row = screen.getByRole("button", { name: new RegExp(longTitle) });
  await userEvent.hover(row);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Delegated from a linked environment. Connect to it to open the parent thread.",
  );

  await row.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("hides a deleted fork and keeps unloaded and archived forks with their current titles", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  state.threadTitles = { "unloaded-fork": "Unloaded fork", "archived-fork": "Archived fork" };
  state.archivedThreads = [
    {
      ...projection.thread,
      id: ThreadId.make("archived-fork"),
      title: "Old archived title",
      archivedAt: projection.thread.updatedAt,
      lineage: { parentThreadId: projection.thread.id, relationshipToParent: "fork" },
    },
  ];
  state.projection = {
    ...projection,
    contextTransfers: ["deleted-fork", "unloaded-fork", "archived-fork"].map((id) => ({
      sourceThreadId: projection.thread.id,
      targetThreadId: ThreadId.make(id),
      status: "pending",
    })),
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await expect.element(screen.getByText("Unloaded fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Archived fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("deleted-fork", { exact: true })).not.toBeInTheDocument();
});

function previousAgentsPage(limit: number, total = 24): OrchestrationV2PreviousAgentsPage {
  return {
    agents: Array.from({ length: Math.min(limit, total) }, (_, index) => ({
      childThreadId: ThreadId.make(`historical-${index}`),
      remoteChild: null,
      title: `Historical agent ${index}`,
      status: "completed",
      providerInstanceId: null,
    })),
    total,
    failedCount: 0,
  };
}

const renderHistoryPanel = () =>
  render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats
    />,
  );

it("counts and reveals previous agents beyond the loaded transcript", async () => {
  setup();
  state.controlledHistory = true;
  await using screen = await renderHistoryPanel();
  await vi.waitFor(() => expect(state.historyRequests.at(-1)?.limit).toBe(6));
  await act(() => state.historyRequests.at(-1)!.resolve(previousAgentsPage(6)));
  await expect
    .element(screen.getByRole("button", { name: /Previous agents/ }))
    .toHaveTextContent("Previous agents24");
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  await screen.getByRole("button", { name: "Show 12 more" }).click();
  await vi.waitFor(() => expect(state.historyRequests.at(-1)?.limit).toBe(18));
  await expect.element(screen.getByRole("button", { name: /Historical agent 5/ })).toBeVisible();
  await act(() => state.historyRequests.at(-1)!.resolve(previousAgentsPage(18)));
  await expect.element(screen.getByRole("button", { name: /Historical agent 17/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Show 6 more" })).toBeVisible();
});

it("refreshes previous agents at the shown limit when a child's status changes", async () => {
  setup();
  state.controlledHistory = true;
  const activeChild = {
    ...makeThreadProjectionFixture().thread,
    id: ThreadId.make("active-child"),
    lineage: { rootThreadId: threadId, parentThreadId: threadId, relationshipToParent: "subagent" },
    status: "running",
    activityRunStatus: "running",
  };
  state.relatedShells = [activeChild];
  await using screen = await renderHistoryPanel();
  await vi.waitFor(() => expect(state.historyRequests).toHaveLength(1));
  await act(() => state.historyRequests.at(-1)!.resolve(previousAgentsPage(6)));
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  await screen.getByRole("button", { name: "Show 12 more" }).click();
  await vi.waitFor(() => expect(state.historyRequests).toHaveLength(2));
  await act(() => state.historyRequests.at(-1)!.resolve(previousAgentsPage(18)));
  state.relatedShells = [{ ...activeChild, status: "idle", activityRunStatus: "completed" }];
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats
    />,
  );
  await vi.waitFor(() => expect(state.historyRequests).toHaveLength(3));
  expect(state.historyRequests.at(-1)?.limit).toBe(18);
  await expect.element(screen.getByRole("button", { name: /Historical agent 17/ })).toBeVisible();
});
