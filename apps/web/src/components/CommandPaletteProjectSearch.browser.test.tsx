import "../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2SearchThreadInput,
  type ProjectCodeQueryResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRouterState } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ kind: string; input: unknown }>,
}));

vi.mock(
  import("../state/server"),
  () =>
    ({
      primaryServerKeybindingsAtom: Atom.make([]),
      serverEnvironment: {
        configValueAtom: () =>
          Atom.make({
            environment: { capabilities: { projectKnowledge: true, projectCode: true } },
            threadFind: true,
          }),
      },
    }) as never,
);
vi.mock(
  import("../state/projectKnowledge"),
  () =>
    ({
      projectKnowledge: {
        search: (target: { input: unknown }) => {
          state.queries.push({ kind: "facts", input: target.input });
          return Atom.make(AsyncResult.failure(Cause.fail(new Error("Fact storage is offline."))));
        },
      },
    }) as never,
);
vi.mock(
  import("../state/orchestration"),
  () =>
    ({
      orchestrationEnvironment: {
        threadSearch: (target: { input: unknown }) => {
          state.queries.push({ kind: "conversations", input: target.input });
          return Atom.make(
            AsyncResult.success({
              matches: [
                {
                  threadId: ThreadId.make("thread-b"),
                  projectId: ProjectId.make("project"),
                  source: "assistant",
                  messageId: MessageId.make("message-b"),
                  snippet: "We retry the token refresh once",
                  messageCreatedAt: null,
                },
              ],
            }),
          );
        },
        // Thread "thread-b" has one match in message-a, then two in message-b; like the
        // server, the first match at or after `start` is selected.
        threadFind: (target: { input: OrchestrationV2SearchThreadInput }) => {
          state.queries.push({ kind: "thread-find", input: target.input });
          const navigation = [
            { entryId: "message-a", runId: null, count: 1, startIndex: 0 },
            { entryId: "message-b", runId: null, count: 2, startIndex: 1 },
          ];
          const selected =
            navigation.find((entry) => entry.entryId === target.input.start?.entryId) ??
            navigation[0]!;
          return Atom.make(
            AsyncResult.success({
              snapshotSequence: 1,
              totalMatches: 3,
              activeIndex: selected.startIndex,
              navigation,
              match: { entryId: selected.entryId, runId: null, occurrence: 0 },
            }),
          );
        },
      },
    }) as never,
);
const codeResult: ProjectCodeQueryResult = {
  operation: "search",
  checkoutPath: "/repo",
  matches: [
    {
      score: 1,
      highlights: [],
      symbol: {
        id: "refresh",
        name: "refreshToken",
        qualifiedName: "refreshToken",
        kind: "function",
        language: "typescript",
        path: "src/auth.ts",
        startLine: 42,
        endLine: 50,
        startColumn: 0,
        endColumn: 1,
        signature: null,
        isExported: true,
      },
    },
  ],
  nodes: [],
  edges: [],
  files: [],
  unresolvedReferences: [],
  selection: { state: "not-required", candidates: [] },
  sourceDigests: [],
  stats: null,
  coverage: {
    state: "complete",
    catalogRevision: "test",
    relationSemantics: "static-candidates",
    columnEncoding: "utf16-code-units",
    languages: ["typescript"],
    filesListed: 1,
    filesIndexed: 1,
    filesSkipped: 0,
    filesUnsupported: 0,
    filesFailed: 0,
    pendingReferences: 0,
    resultLimitReached: false,
    limitations: [],
  },
};
vi.mock(
  import("../state/projectCode"),
  () =>
    ({
      projectCode: {
        query: Object.assign(
          (target: { input: unknown }) => {
            state.queries.push({ kind: "symbols", input: target.input });
            return Atom.make(AsyncResult.success(codeResult));
          },
          { permissionAtom: () => Atom.make(true) },
        ),
      },
    }) as never,
);
vi.mock(
  import("../state/entities"),
  () =>
    ({
      useProjects: () => [],
      useThreadProjection: () => null,
      useThreadShells: () => [{ environmentId: "env", id: "thread-b", title: "Auth refresh bug" }],
    }) as never,
);
vi.mock(import("../hooks/useHandleNewThread"), () => ({ useHandleNewThread: () => ({}) }) as never);
vi.mock(
  import("./projectKnowledge/ProjectMemoryPanel"),
  () => ({ useOpenProjectMemory: () => () => {} }) as never,
);

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { OpenProjectSearchPalette, type ProjectSearchTarget } from "./CommandPaletteProjectSearch";
import { ThreadFindBar } from "./chat/ThreadFindBar";
import { useThreadFind } from "./chat/useThreadFind";

const target: ProjectSearchTarget = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  projectName: "Demo",
  threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread-a") },
  serverThreadId: ThreadId.make("thread-a"),
};

function RoutedThreadFind() {
  const threadId = useRouterState({ select: (router) => router.location.pathname.split("/")[2] });
  // Keyed like a thread view, so the target thread's find mounts only after navigation.
  return threadId ? <ThreadFindView key={threadId} threadId={ThreadId.make(threadId)} /> : null;
}

function ThreadFindView(props: { readonly threadId: ThreadId }) {
  const find = useThreadFind({
    thread: scopeThreadRef(target.environmentId, props.threadId),
    enabled: true,
  });
  return (
    <div data-thread={props.threadId}>
      <ThreadFindBar {...find.barProps} />
      <output aria-label="Active match">{find.timelineProps.activeFindMatch?.entryId}</output>
    </div>
  );
}

function setup() {
  state.queries.length = 0;
  useRightPanelStore.setState({ byThreadKey: {} });
  return { registry: AtomRegistry.make(), setOpen: vi.fn() };
}

it("keeps each group independent when one source fails, and opens symbols and conversations", async () => {
  const { registry, setOpen } = setup();
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <OpenProjectSearchPalette target={target} setOpen={setOpen} />
      <RoutedThreadFind />
    </RegistryContext.Provider>,
    { router: "/env/thread-a" },
  );

  await userEvent.fill(screen.getByRole("combobox"), "refresh token");

  // Facts fail on their own; the other groups still render their results.
  await expect.element(screen.getByText("Fact storage is offline.")).toBeVisible();
  await expect.element(screen.getByText("Auth refresh bug")).toBeVisible();
  await expect.element(screen.getByText("function · src/auth.ts:42")).toBeVisible();
  expect(state.queries.map((query) => query.kind).toSorted()).toEqual([
    "conversations",
    "facts",
    "symbols",
  ]);
  expect(state.queries.find((query) => query.kind === "symbols")?.input).toEqual({
    projectId: target.projectId,
    threadId: target.serverThreadId,
    query: { operation: "search", text: "refresh token", limit: 8 },
  });

  await screen.getByText("function · src/auth.ts:42").click();
  expect(setOpen).toHaveBeenCalledWith(false);
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, target.threadRef),
  ).toMatchObject({ relativePath: "src/auth.ts", revealLine: 42 });

  await screen.getByText("Auth refresh bug").click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/thread-b"));
  // The conversation lands on its message, finding the query's longest word since the
  // snippet does not hold the whole query as typed.
  await expect.element(screen.getByPlaceholder("Find in thread")).toHaveValue("refresh");
  await expect
    .element(screen.getByRole("status", { name: "Active match" }))
    .toHaveTextContent("message-b");
  const findBar = screen.getByRole("search", { name: "Find in thread" }).element();
  await expect
    .element(findBar.querySelector<HTMLSpanElement>("span[aria-hidden]"))
    .toHaveTextContent("2/3");
  expect(state.queries.find((query) => query.kind === "thread-find")?.input).toMatchObject({
    threadId: "thread-b",
    query: "refresh",
    start: { entryId: "message-b", occurrence: 0 },
  });
});
