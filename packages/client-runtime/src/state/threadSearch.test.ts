import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createThreadSearchResultsAtomFamily,
  findThreadSearchOccurrences,
  makeThreadSearchKey,
  splitThreadSearchText,
  threadSearchMatchKey,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("finds non-overlapping occurrences without invalidating Unicode offsets", () => {
  expect(findThreadSearchOccurrences("Deploy the Deployment", "deploy")).toEqual([0, 11]);
  expect(findThreadSearchOccurrences("aaaa", "aa")).toEqual([0, 2]);
  expect(findThreadSearchOccurrences("İİİ needle", "needle")).toEqual([4]);
});

it("splits search text into highlighted and unhighlighted parts", () => {
  expect(splitThreadSearchText("one TWO three two", " two ")).toEqual([
    { text: "one ", highlighted: false, start: 0 },
    { text: "TWO", highlighted: true, start: 4 },
    { text: " three ", highlighted: false, start: 7 },
    { text: "two", highlighted: true, start: 14 },
  ]);
});

it("creates stable keys regardless of environment order", () => {
  expect(makeThreadSearchKey([envB, envA], "needle")).toBe(
    makeThreadSearchKey([envA, envB], "needle"),
  );
});

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
