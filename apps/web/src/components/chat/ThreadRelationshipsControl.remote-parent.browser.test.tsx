import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

const { read, toast } = vi.hoisted(() => ({
  read: vi.fn<(input: unknown) => Promise<unknown>>(),
  toast: vi.fn(),
}));

const childEnvironmentId = EnvironmentId.make("child-environment");
const childThreadId = ThreadId.make("child-thread");
const parentEnvironmentId = EnvironmentId.make("parent-environment");
// The panel reads only identity, lineage and delegation from the current thread.
const child = {
  id: childThreadId,
  title: "Child",
  lineage: { rootThreadId: childThreadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  delegatedFrom: {
    environmentId: parentEnvironmentId,
    threadId: ThreadId.make("parent-thread"),
    title: "Parent",
  },
} as Partial<OrchestrationV2ThreadShell> as OrchestrationV2ThreadShell;

vi.mock(import("../../state/orchestration"), async (original) => ({
  ...(await original()),
  threadProjectionRead: {
    label: "thread-projection-read",
    run: (_registry: unknown, input: unknown) => read(input),
  } as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: () => null,
  useThreadRelationshipShells: () => [child],
  // The parent is absent from this client's shell, as for a parent never loaded here.
  useQuietThreadShell: () => null,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "Linked" })) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const childPath = `/${childEnvironmentId}/${childThreadId}`;
const parentPath = `/${parentEnvironmentId}/parent-thread`;

const live = { _tag: "Success", value: { thread: { deletedAt: null } } };
const deleted = { _tag: "Success", value: { thread: { deletedAt: "2026-10-30T06:20:20.897Z" } } };

// Renders the child's panel; each read of its parent answers with the next of `replies`.
function renderChild(...replies: ReadonlyArray<unknown>) {
  read.mockReset();
  for (const reply of replies) read.mockImplementationOnce(async () => reply);
  toast.mockReset();
  return render(
    <ThreadRelationshipsPanel environmentId={childEnvironmentId} threadId={childThreadId} />,
    { router: childPath },
  );
}

const parentRow = (screen: Screen) => screen.getByRole("button", { name: /Parent/ });

it.each([
  {
    parent: "deleted there",
    reply: deleted,
    feedback: { type: "info", title: "The parent thread was deleted" },
  },
  {
    parent: "unreadable",
    reply: {
      _tag: "Failure",
      cause: Cause.fail(new Error("Failed to load orchestration V2 thread")),
    },
    feedback: { type: "error", title: "Could not open the parent thread" },
  },
])("keeps the child open with feedback when its remote parent is $parent", async (row) => {
  await using screen = await renderChild(row.reply);
  await parentRow(screen).click();
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(row.feedback));
  expect(read).toHaveBeenCalledWith({
    environmentId: parentEnvironmentId,
    input: { threadId: "parent-thread" },
  });
  expect(screen.router?.state.location.pathname).toBe(childPath);
});

it("opens a remote parent this client has not loaded", async () => {
  await using screen = await renderChild(live);
  await parentRow(screen).click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe(parentPath));
  expect(toast).not.toHaveBeenCalled();
});

it("leaves the user where they went when the parent read answers late", async () => {
  let answerLate!: (reply: unknown) => void;
  const late = new Promise((resolve) => {
    answerLate = resolve;
  });
  await using screen = await renderChild(late, deleted);
  await parentRow(screen).click();
  await screen.router?.navigate({ to: "/new" });
  await act(async () => {
    answerLate(live);
    await late;
  });
  expect(toast).not.toHaveBeenCalled();
  expect(screen.router?.latestLocation.pathname).toBe("/new");
  await parentRow(screen).click();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
  expect(screen.router?.latestLocation.pathname).toBe("/new");
});
