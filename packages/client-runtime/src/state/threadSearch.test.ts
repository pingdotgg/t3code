import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  claimThreadOpen,
  nextShownOrder,
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  threadSearchMatchKey,
  threadSearchSubject,
  visibleThreadSearch,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("creates keys without array methods unavailable in Hermes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");

  try {
    expect(makeThreadSearchKey([envB, envA], "needle")).toBe('[["env-a","env-b"],"needle"]');
  } finally {
    if (descriptor !== undefined) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
});

it("encodes scoped thread keys without delimiter collisions", () => {
  const first = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env\u0000thread"),
    threadId: ThreadId.make("id"),
  });
  const second = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread\u0000id"),
  });

  expect(first).not.toBe(second);
});

it("ignores invalid search keys", () => {
  let searchCount = 0;
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: () => {
      searchCount += 1;
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  }).results;
  const registry = AtomRegistry.make();

  try {
    const state = registry.get(searchAtom(makeThreadSearchKey([envA], "a".repeat(201))));
    const malformedState = registry.get(searchAtom("not json{{"));
    const emptyScope = registry.get(
      searchAtom(makeThreadSearchKey([], "needle", { projectIds: [] })),
    );

    expect(state).toEqual({ matches: [], isLoading: false, rows: [] });
    expect(malformedState).toEqual({ matches: [], isLoading: false, rows: [] });
    expect(emptyScope).toEqual({ matches: [], isLoading: false, rows: [] });
    expect(searchCount).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("merges successful environments and silently ignores failures", () => {
  const result: OrchestrationSearchThreadsResult = {
    matches: [
      {
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user",
        snippet: "needle",
        messageCreatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (environmentId) =>
      environmentId === envA
        ? Atom.make(AsyncResult.success(result))
        : Atom.make(
            AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
              Cause.fail(new Error("unsupported rpc")),
            ),
          ),
    labelPrefix: "test:thread-search",
  }).results;
  const registry = AtomRegistry.make();

  const state = registry.get(searchAtom(makeThreadSearchKey([envB, envA], "needle")));
  expect(state).toEqual({
    matches: [{ ...result.matches[0], environmentId: envA }],
    isLoading: false,
    rows: [],
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});

it("asks environments that omit older settled threads for their rows, with the caller's scope", () => {
  const inputs: Array<readonly [EnvironmentId, OrchestrationV2SearchThreadsInput]> = [];
  const row = { id: ThreadId.make("thread-old") } as OrchestrationV2ThreadShell;
  const search = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (environmentId, input) => {
      inputs.push([environmentId, input]);
      return Atom.make(AsyncResult.success({ matches: [], snapshotSequence: 9, threads: [row] }));
    },
    olderSettledBefore: (environmentId) =>
      Atom.make(environmentId === envA ? "2026-10-01T00:00:00.000Z" : null),
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();
  const scope = {
    projectIds: [ProjectId.make("project-a")],
    environmentLabels: { [envA]: "Laptop" },
  };

  // Too short to match messages: only the environment with older rows is asked, for titles.
  const key = makeThreadSearchKey([envA, envB], "ui", scope);
  expect(registry.get(search.results(key)).rows).toEqual([
    { environmentId: envA, read: { snapshotSequence: 9, threads: [row] } },
  ]);
  expect(registry.get(search.rows(key, envA))).toEqual([{ snapshotSequence: 9, threads: [row] }]);
  expect(inputs).toEqual([
    [
      envA,
      {
        query: "ui",
        olderSettledBefore: "2026-10-01T00:00:00.000Z",
        projectIds: scope.projectIds,
        environmentLabel: "Laptop",
        titlesOnly: true,
      },
    ],
  ]);
  inputs.length = 0;
  registry.get(search.results(makeThreadSearchKey([envB], "needle")));
  expect(inputs).toEqual([[envB, { query: "needle" }]]);

  registry.dispose();
});

it("keeps the previous results visible only while a refined or widened query is pending", () => {
  const previous = {
    query: "websock",
    matches: [
      {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user" as const,
        snippet: "websocket reconnect",
        messageCreatedAt: null,
      },
    ],
  };
  expect(visibleThreadSearch("websocke", null, previous)).toBe(previous);
  expect(visibleThreadSearch("webso", null, previous)).toBe(previous);
  expect(visibleThreadSearch("billing", null, previous)).toEqual({ query: "", matches: [] });
  const ready = { query: "websocke", matches: [] };
  expect(visibleThreadSearch("websocke", ready, previous)).toBe(ready);
});

it("ranks recent threads by this client's own latest open", () => {
  const thread = {
    environmentId: envA,
    id: ThreadId.make("thread-local"),
    title: "Local",
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: { openedAt: 1_000, score: 1, picks: [] },
  };
  claimThreadOpen(envA, "thread-local", 5_000);
  expect(threadSearchSubject(thread, null).opens?.openedAt).toBe(5_000);
  // Also when the server has no record of opens, as an older server would not.
  claimThreadOpen(envA, "thread-unrecorded", 6_000);
  expect(
    threadSearchSubject({ ...thread, id: ThreadId.make("thread-unrecorded"), opens: null }, null)
      .opens,
  ).toEqual({ openedAt: 6_000, score: 1, picks: [] });
});

it("counts recency from what the user wrote, else from when the thread began", () => {
  const thread = {
    environmentId: envA,
    id: ThreadId.make("thread-agent"),
    title: "Launched by an agent",
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    latestUserMessageAt: "2026-10-20T00:00:00.000Z",
    opens: null,
  };
  expect(
    threadSearchSubject({ ...thread, latestUserAuthoredMessageAt: null }, null).activityAt,
  ).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
  expect(
    threadSearchSubject(
      { ...thread, latestUserAuthoredMessageAt: "2026-10-05T00:00:00.000Z" },
      null,
    ).activityAt,
  ).toBe(Date.parse("2026-10-05T00:00:00.000Z"));
  // An older server omits the field.
  expect(threadSearchSubject(thread, null).activityAt).toBe(Date.parse("2026-10-20T00:00:00.000Z"));
});

it("keeps shown message rows in place and leaves room for a slower environment", () => {
  // The fast environment answers first and fills the limit.
  const fast = Array.from({ length: 12 }, (_, index) => `a${index}`);
  const first = nextShownOrder(null, "rust", fast, 10);
  expect(first.keys.slice(0, first.shown)).toEqual(fast.slice(0, 10));
  // The slow one's matches rank first: shown rows hold, and its best few come next.
  const slow = ["b0", "b1", "b2", "b3"];
  const second = nextShownOrder(first, "rust", [...slow, ...fast], 10);
  expect(second.keys.slice(0, second.shown)).toEqual([...fast.slice(0, 10), "b0", "b1", "b2"]);
  // Nothing new: nothing moves and nothing grows.
  expect(nextShownOrder(second, "rust", [...slow, ...fast], 10)).toBe(second);
  // A third environment gets no more room past the limit.
  const third = nextShownOrder(second, "rust", ["c0", ...slow, ...fast], 10);
  expect(third.shown).toBe(13);
  expect(third.keys.slice(0, 13)).toEqual(second.keys.slice(0, 13));
  // A new query starts from its own ranking.
  expect(nextShownOrder(second, "rusty", ["b0"], 10).keys).toEqual(["b0"]);
});

it("sends one open per thread every ten minutes by this client's clock", () => {
  const minute = 60_000;
  expect(claimThreadOpen(envA, "thread-open", 0)).toBe(true);
  expect(claimThreadOpen(envA, "thread-open", 9 * minute)).toBe(false);
  expect(claimThreadOpen(envB, "thread-open", 9 * minute)).toBe(true);
  expect(claimThreadOpen(envA, "thread-open", 10 * minute)).toBe(true);
});
