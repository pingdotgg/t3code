import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { BearerConnectionTarget } from "../connection/model.ts";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
  threadSearchMatchKey,
  threadSearchSourceMessage,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

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

it("accepts search keys at the maximum decoded query length", () => {
  const queries: string[] = [];
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (_environmentId, query) => {
      queries.push(query);
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();
  const query = "a".repeat(200);

  try {
    registry.get(searchAtom(makeThreadSearchKey([envA], query)));
    registry.get(searchAtom(makeThreadSearchKey([envA], ` ${query} `)));

    expect(queries).toEqual([query, query]);
  } finally {
    registry.dispose();
  }
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

    expect(state).toEqual({ matches: [], isLoading: false, sources: [] });
    expect(malformedState).toEqual({ matches: [], isLoading: false, sources: [] });
    expect(searchCount).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("merges successful environments and reports failed scope", () => {
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
    sources: [
      { environmentId: envA, label: envA, status: "complete", isStale: false },
      { environmentId: envB, label: envB, status: "failed", isStale: false },
    ],
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});

function presentation(
  environmentId: EnvironmentId,
  phase: EnvironmentPresentation["connection"]["phase"],
): EnvironmentPresentation {
  return {
    entry: {
      target: new BearerConnectionTarget({
        environmentId,
        label: environmentId === envA ? "Laptop" : "Remote",
        connectionId: environmentId,
      }),
      enabled: true,
      profile: Option.none(),
    },
    connection: { phase, error: null, traceId: null },
    serverConfig: null,
  };
}

const oneMatch: OrchestrationSearchThreadsResult = {
  matches: [
    {
      threadId: ThreadId.make("thread"),
      projectId: ProjectId.make("project"),
      source: "user",
      snippet: "needle",
      messageCreatedAt: null,
    },
  ],
};

function harness() {
  const registry = AtomRegistry.make();
  const a = Atom.make<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, Error>>(
    AsyncResult.success(oneMatch),
  );
  const b = Atom.make<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, Error>>(
    AsyncResult.success(oneMatch),
  );
  const connection = Atom.make<EnvironmentPresentation | null>(presentation(envB, "connected"));
  const local = Atom.make<EnvironmentPresentation | null>(presentation(envA, "connected"));
  const family = createThreadSearchResultsAtomFamily({
    getSearchAtom: (id) => (id === envA ? a : b),
    getEnvironmentAtom: (id) => (id === envA ? local : connection),
    labelPrefix: "test:thread-search",
  });
  const atom = family(makeThreadSearchKey([envA, envB], "needle"));
  registry.mount(atom);
  return { registry, a, b, connection, atom, read: () => registry.get(atom) };
}

it("keeps both successful environments and distinguishes complete no-match responses", () => {
  const h = harness();
  try {
    expect(h.read().matches.map((match) => match.environmentId)).toEqual([envA, envB]);
    expect(h.read().sources.map((source) => source.status)).toEqual(["complete", "complete"]);
    h.registry.set(h.a, AsyncResult.success({ matches: [] }));
    h.registry.set(h.b, AsyncResult.success({ matches: [] }));
    expect(h.read().matches).toEqual([]);
    expect(h.read().sources.every((source) => source.status === "complete")).toBe(true);
  } finally {
    h.registry.dispose();
  }
});

it("retains successful scope while another environment waits and both fail", () => {
  const h = harness();
  try {
    h.registry.set(h.b, AsyncResult.initial());
    expect(h.read().isLoading).toBe(true);
    expect(h.read().matches).toHaveLength(1);
    expect(h.read().sources[1]?.status).toBe("pending");
    h.registry.set(h.b, AsyncResult.failure(Cause.fail(new Error("request failed"))));
    expect(h.read().isLoading).toBe(false);
    expect(h.read().matches).toHaveLength(1);
    h.registry.set(h.a, AsyncResult.failure(Cause.fail(new Error("request failed"))));
    expect(h.read().matches).toEqual([]);
    expect(h.read().sources.map((source) => source.status)).toEqual(["failed", "failed"]);
  } finally {
    h.registry.dispose();
  }
});

it("keeps cached matches through failed revalidation and recovery of the same query", () => {
  const h = harness();
  try {
    const previous = h.registry.get(h.b);
    h.registry.set(
      h.b,
      AsyncResult.failureWithPrevious(Cause.fail(new Error("unavailable")), {
        previous: Option.some(previous),
      }),
    );
    expect(h.read().matches).toHaveLength(2);
    expect(h.read().sources[1]).toMatchObject({ label: "Remote", status: "failed", isStale: true });
    h.registry.set(h.b, AsyncResult.success(oneMatch, { waiting: true }));
    expect(h.read().sources[1]).toMatchObject({ status: "pending", isStale: true });
    expect(h.read().matches).toHaveLength(2);
    h.registry.set(h.b, AsyncResult.success(oneMatch));
    expect(h.read().sources[1]).toMatchObject({ status: "complete", isStale: false });
    expect(h.read().matches).toHaveLength(2);
  } finally {
    h.registry.dispose();
  }
});

it.each(["offline", "available", "connecting", "reconnecting", "error"] as const)(
  "keeps %s environments in scope even when the query atom still has a success",
  (phase) => {
    const h = harness();
    try {
      h.registry.set(h.connection, presentation(envB, phase));
      expect(h.read().sources[1]).toMatchObject({
        label: "Remote",
        status: "disconnected",
        isStale: true,
      });
      expect(h.read().matches).toHaveLength(2);
      h.registry.set(h.connection, presentation(envB, "connected"));
      expect(h.read().sources[1]?.status).toBe("complete");
    } finally {
      h.registry.dispose();
    }
  },
);

it("does not treat missing or incompatible environments as successful empty searches", () => {
  const h = harness();
  try {
    h.registry.set(h.connection, null);
    expect(h.read().sources[1]?.status).toBe("disconnected");
    h.registry.set(h.connection, presentation(envB, "unsupported"));
    expect(h.read().sources[1]?.status).toBe("unsupported");
  } finally {
    h.registry.dispose();
  }
});

it("recognizes the old server unknown search RPC without treating generic failures as unsupported", () => {
  const registry = AtomRegistry.make();
  // RpcServer sends an unknown request tag as a defect; RpcClient decodes it
  // to Exit.die rather than a declared RPC failure.
  const result = Atom.make<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, Error>>(
    AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
      Cause.die(`Unknown request tag: ${ORCHESTRATION_WS_METHODS.searchThreads}`),
    ),
  );
  const family = createThreadSearchResultsAtomFamily({
    getSearchAtom: () => result,
    labelPrefix: "legacy",
  });
  const atom = family(makeThreadSearchKey([envA], "needle"));
  registry.mount(atom);
  try {
    const source = registry.get(atom).sources[0]!;
    expect(source.status).toBe("unsupported");
    expect(threadSearchSourceMessage(source)).toContain("Local titles still searched");
    registry.set(
      result,
      AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
        Cause.die("Unexpected server error"),
      ),
    );
    expect(registry.get(atom).sources[0]?.status).toBe("failed");
  } finally {
    registry.dispose();
  }
});

it("qualifies a full response as possibly limited, not proven truncated", () => {
  const h = harness();
  try {
    h.registry.set(
      h.b,
      AsyncResult.success({
        matches: Array.from({ length: 50 }, (_, index) => ({
          ...oneMatch.matches[0]!,
          threadId: ThreadId.make(`thread-${index}`),
        })),
      }),
    );
    const source = h.read().sources[1]!;
    expect(source.status).toBe("limited");
    expect(threadSearchSourceMessage(source)).toContain("more may exist");
    expect(h.read().matches).toHaveLength(51);
  } finally {
    h.registry.dispose();
  }
});

it.each(["", " ", "a", "a".repeat(201)])(
  "does not query unavailable environments for invalid query %j",
  (query) => {
    const registry = AtomRegistry.make();
    const family = createThreadSearchResultsAtomFamily({
      getSearchAtom: () => {
        throw new Error("must not search");
      },
      labelPrefix: "invalid",
    });
    try {
      expect(registry.get(family(makeThreadSearchKey([envB], query)))).toEqual({
        matches: [],
        isLoading: false,
        sources: [],
      });
    } finally {
      registry.dispose();
    }
  },
);
