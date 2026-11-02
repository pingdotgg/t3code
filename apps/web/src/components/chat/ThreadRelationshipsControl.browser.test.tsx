import * as DateTime from "effect/DateTime";
import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  commandSucceeds: false,
  relatedShells: [] as unknown[],
  family: null as unknown,
  familyAtom: null as unknown,
  removedAt: new Map<string, number>(),
  removedAtAtom: null as unknown,
  archived: null as unknown,
  refreshArchived: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, select?: (value: unknown) => unknown) =>
    atom === state.familyAtom
      ? select
        ? select(state.family)
        : state.family
      : atom === state.removedAtAtom
        ? state.removedAt
        : false) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: (() => null) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
  useThreadRelationshipShells: (() =>
    state.projection === null
      ? []
      : [(state.projection as { thread: unknown }).thread, ...state.relatedShells]) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => state.archived) as never,
  refreshArchivedThreadsForEnvironment: state.refreshArchived,
}));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  state.familyAtom = Atom.make(null);
  state.removedAtAtom = Atom.make(null);
  return {
    ...actual,
    threadFamilies: {
      ...actual.threadFamilies,
      familyAtom: (() => state.familyAtom) as never,
      removedAtAtom: (() => state.removedAtAtom) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () =>
    state.commandSucceeds
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(Cause.fail(new Error("Connection lost")))) as never,
}));

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ToastProvider } from "../ui/toast";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("fork");

function setup() {
  state.commandSucceeds = false;
  state.relatedShells = [];
  state.family = AsyncResult.initial(true);
  state.removedAt = new Map();
  state.archived = {
    snapshots: [{ environmentId, snapshot: { snapshotSequence: 1, projects: [], threads: [] } }],
    error: null,
    isLoading: false,
  };
  state.refreshArchived.mockClear();
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
          label: "Remote VM",
        },
      },
    ],
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
    "Runs on Remote VM. Connect to it to open the thread there.",
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

function setupSourceWithTransfers(
  transfers: ReadonlyArray<{
    sourceThreadId: string;
    targetThreadId: string;
    type: string;
    status: string;
  }>,
  familyThreads: ReadonlyArray<{ id: string; title: string }>,
) {
  setup();
  const source = {
    id: "source",
    title: "Source",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "source" },
    forkedFrom: null,
  };
  const liveFork = {
    id: "live-fork",
    title: "Live fork",
    lineage: { parentThreadId: "source", relationshipToParent: "fork", rootThreadId: "source" },
    forkedFrom: null,
  };
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    thread: source,
    contextTransfers: transfers,
  };
  state.relatedShells = [liveFork];
  state.family = AsyncResult.success({
    snapshotSequence: 1,
    threads: [
      source,
      liveFork,
      ...familyThreads.map((thread) => ({
        ...thread,
        lineage: { parentThreadId: "source", relationshipToParent: "fork", rootThreadId: "source" },
        forkedFrom: null,
      })),
    ],
  });
}

it.each([
  [
    "a pending fork transfer",
    { sourceThreadId: "source", targetThreadId: "deleted-fork", type: "fork", status: "pending" },
  ],
  [
    "a merge-back transfer",
    {
      sourceThreadId: "deleted-fork",
      targetThreadId: "source",
      type: "merge_back",
      status: "consumed",
    },
  ],
])("hides a deleted fork that left %s once its family read is settled", async (_, transfer) => {
  setupSourceWithTransfers([transfer], []);
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={ThreadId.make("source")}
      showLineage
      showSideChats={false}
    />,
  );

  await expect.element(screen.getByText("Live fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("deleted-fork")).not.toBeInTheDocument();
});

it.each([
  ["pending", AsyncResult.initial(true)],
  ["failed", AsyncResult.failure(Cause.fail("read failed"))],
])("keeps a fork missing from the shell while its family read is %s", async (_, family) => {
  setupSourceWithTransfers(
    [{ sourceThreadId: "source", targetThreadId: "older-fork", type: "fork", status: "pending" }],
    [],
  );
  state.family = family;
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={ThreadId.make("source")}
      showLineage
      showSideChats={false}
    />,
  );

  await expect.element(screen.getByText("older-fork")).toBeVisible();
});

it.each([
  ["its archive read failed", false],
  ["its archive read predates the fork's removal", true],
])("keeps a fork missing from a settled family read when %s", async (_, staleArchive) => {
  setupSourceWithTransfers(
    [
      {
        sourceThreadId: "source",
        targetThreadId: "archived-fork",
        type: "fork",
        status: "pending",
      },
    ],
    [],
  );
  if (staleArchive) state.removedAt = new Map([["archived-fork", 2]]);
  else
    state.archived = { snapshots: [], error: "Failed to load archived threads.", isLoading: false };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={ThreadId.make("source")}
      showLineage
      showSideChats={false}
    />,
  );

  await expect.element(screen.getByText("archived-fork")).toBeVisible();
  expect(state.refreshArchived).toHaveBeenCalledTimes(staleArchive ? 1 : 0);
});

it("titles an older fork the shell omitted from its family read", async () => {
  setupSourceWithTransfers(
    [{ sourceThreadId: "source", targetThreadId: "older-fork", type: "fork", status: "consumed" }],
    [{ id: "older-fork", title: "Older fork" }],
  );
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={ThreadId.make("source")}
      showLineage
      showSideChats={false}
    />,
  );

  await expect.element(screen.getByText("Older fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("older-fork")).not.toBeInTheDocument();
});
