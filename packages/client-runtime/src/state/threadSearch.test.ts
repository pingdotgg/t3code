import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  threadSearchMatchKey,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("creates keys without array methods unavailable in Hermes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");

  try {
    expect(makeThreadSearchKey([envB, envA], "needle")).toBe('[["env-a","env-b"],"needle",null]');
  } finally {
    if (descriptor !== undefined) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
});

it("separates scoped searches and forwards eligibility to each environment", () => {
  const a = ThreadId.make("thread-a");
  const b = ThreadId.make("thread-b");
  const scope = { [envA]: [b, a], [envB]: [] };
  const key = makeThreadSearchKey([envB, envA], "needle", scope);
  expect(key).toBe(makeThreadSearchKey([envA, envB], "needle", { [envB]: [], [envA]: [a, b] }));
  expect(key).not.toBe(makeThreadSearchKey([envA, envB], "needle"));
  const requests: unknown[] = [];
  const family = createThreadSearchResultsAtomFamily({
    getSearchAtom: (environmentId, query, threadIds) => {
      requests.push({ environmentId, query, threadIds });
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:scoped-search",
  });
  const registry = AtomRegistry.make();
  try {
    registry.get(family(key));
    expect(requests).toEqual([
      { environmentId: envA, query: "needle", threadIds: [a, b] },
      { environmentId: envB, query: "needle", threadIds: [] },
    ]);
  } finally {
    registry.dispose();
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
  });
  const registry = AtomRegistry.make();

  try {
    const state = registry.get(searchAtom(makeThreadSearchKey([envA], "a".repeat(201))));
    const malformedState = registry.get(searchAtom("not json{{"));

    expect(state).toEqual({ matches: [], isLoading: false });
    expect(malformedState).toEqual({ matches: [], isLoading: false });
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
  });
  const registry = AtomRegistry.make();

  const state = registry.get(searchAtom(makeThreadSearchKey([envB, envA], "needle")));
  expect(state).toEqual({
    matches: [{ ...result.matches[0], environmentId: envA }],
    isLoading: false,
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});
