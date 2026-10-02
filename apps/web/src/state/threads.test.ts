import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createRunningThreadKeepAliveAtom } from "./threads";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

type Status = "running" | "starting" | "idle";
function shell(id: string, status: Status | null) {
  return { id: ThreadId.make(id), status: status ?? "idle" } satisfies Pick<
    OrchestrationV2ThreadShell,
    "id" | "status"
  >;
}
function detail(id: string, status: Status, overrides: Partial<EnvironmentThreadState> = {}) {
  const projection = makeThreadProjectionFixture();
  const threadId = ThreadId.make(id);
  const thread = {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runs:
      status === "idle"
        ? []
        : [
            {
              id: RunId.make(`run-${id}`),
              threadId,
              ordinal: 1,
              providerInstanceId: projection.thread.providerInstanceId,
              modelSelection: projection.thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message-${id}`),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: projection.updatedAt,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
  };
  return AsyncResult.success<EnvironmentThreadState>({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(thread),
    ...overrides,
  });
}

function makeHarness() {
  // Registry cleanup runs only on `flush`, like the real deferred task.
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const environmentIds = Atom.make<ReadonlyArray<EnvironmentId>>([LOCAL, REMOTE]).pipe(
    Atom.keepAlive,
  );
  const threads = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<ReturnType<typeof shell>>>([]).pipe(Atom.keepAlive),
  );
  // Stand-ins for the thread state atoms. Each one lives only while mounted,
  // as the real stream does.
  const keys = new Set<string>();
  const states = Atom.family((_key: string) =>
    Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState>>(
      AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
    ),
  );
  const stateAtom = (environmentId: EnvironmentId, threadId: string) => {
    const key = `${environmentId}:${threadId}`;
    keys.add(key);
    return states(key);
  };
  const keepAlive = createRunningThreadKeepAliveAtom({
    environmentIdsAtom: environmentIds,
    threadsAtom: threads,
    stateAtom,
  });
  registry.mount(keepAlive);
  return {
    registry,
    environmentIds,
    threads,
    stateAtom,
    keepAlive,
    openStreams: () => {
      flush();
      return [...keys].filter((key) => registry.getNodes().has(states(key))).toSorted();
    },
  };
}

describe("createRunningThreadKeepAliveAtom", () => {
  it("keeps running threads open across shell updates and thread view visits", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "idle"), shell("c", null)]);
    h.registry.set(h.threads(REMOTE), [shell("d", "starting")]);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);

    // A thread view that comes and goes shares the kept stream.
    const live = detail("a", "running");
    h.registry.set(h.stateAtom(LOCAL, "a"), live);
    h.registry.mount(h.stateAtom(LOCAL, "a"))();

    // A shell update that starts or stops nothing does not rebuild the set.
    const kept = h.registry.get(h.keepAlive);
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "idle")]);
    expect(h.registry.get(h.keepAlive)).toBe(kept);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);
    expect(h.registry.get(h.stateAtom(LOCAL, "a"))).toBe(live);
  });

  it("holds a stopped thread until its own stream is live and shows the stop", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "running"),
      shell("b", "running"),
      shell("c", "running"),
    ]);
    // "b" has not loaded yet. "c" hit a stream error.
    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "running"));
    h.registry.set(
      h.stateAtom(LOCAL, "c"),
      detail("c", "running", { status: "cached", error: Option.some("Could not sync.") }),
    );

    // The shell reports the stops first. A failed stream cannot deliver its
    // stop, so only it is released now.
    h.registry.set(h.threads(LOCAL), [shell("a", "idle"), shell("b", "idle"), shell("c", "idle")]);
    expect(h.openStreams()).toEqual(["local:a", "local:b"]);

    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "idle"));
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "idle", { status: "synchronizing" }));
    expect(h.openStreams()).toEqual(["local:b"]);
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "idle"));
    expect(h.openStreams()).toEqual([]);
  });

  it("follows environments that connect and go away", () => {
    const h = makeHarness();
    h.registry.set(h.environmentIds, [LOCAL]);
    h.registry.set(h.threads(REMOTE), [shell("d", "running")]);
    expect(h.openStreams()).toEqual([]);

    h.registry.set(h.environmentIds, [LOCAL, REMOTE]);
    expect(h.openStreams()).toEqual(["remote:d"]);

    // Removal drops every mount, including one still waiting for its stop.
    h.registry.set(h.stateAtom(REMOTE, "d"), detail("d", "running"));
    h.registry.set(h.threads(REMOTE), [shell("d", "idle")]);
    expect(h.openStreams()).toEqual(["remote:d"]);
    h.registry.set(h.environmentIds, [LOCAL]);
    expect(h.openStreams()).toEqual([]);
  });
});
