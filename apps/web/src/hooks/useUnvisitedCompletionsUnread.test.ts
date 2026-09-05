import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentCacheStore } from "@t3tools/client-runtime/platform";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import {
  applyShellStreamEvent,
  makeEnvironmentShellState,
  ShellSnapshotLoader,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach } from "vite-plus/test";

import { hasUnseenCompletion, resolveThreadStatusPill } from "../components/Sidebar.logic";
import { parsePersistedState, useUiStateStore } from "../uiStateStore";
import { subscribeToUnvisitedCompletions } from "./useUnvisitedCompletionsUnread";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const COMPLETED_AT = "2026-09-05T08:00:12.790Z";
const LATER_COMPLETION = "2026-09-05T08:02:00.000Z";
const INITIAL: OrchestrationThreadShell = {
  id: ThreadId.make("audit3131-background-2"),
  projectId: ProjectId.make("audit-project"),
  title: "Audit unread background 2",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex_audit3131"),
    model: "fixture-model",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-09-05T08:00:02.511Z",
  updatedAt: "2026-09-05T08:00:02.511Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
};

function thread(
  completedAt: string | null = COMPLETED_AT,
  state: "running" | "completed" | "interrupted" | "error" = "completed",
): OrchestrationThreadShell {
  return {
    ...INITIAL,
    updatedAt: completedAt ?? INITIAL.updatedAt,
    latestTurn: {
      turnId: TurnId.make("019fcfd6-1806-7de1-8564-de69fd55bffb"),
      state,
      requestedAt: "2026-09-05T08:00:12.517Z",
      startedAt: "2026-09-05T08:00:12.517Z",
      completedAt,
      assistantMessageId: null,
    },
  };
}

function snapshot(
  threads: ReadonlyArray<OrchestrationThreadShell> = [],
): OrchestrationShellSnapshot {
  return { snapshotSequence: 28, projects: [], threads, updatedAt: INITIAL.createdAt };
}

function shell(
  status: EnvironmentShellState["status"],
  value: OrchestrationShellSnapshot = snapshot(),
): EnvironmentShellState {
  return {
    status,
    snapshot: status === "empty" ? Option.none() : Option.some(value),
    error: Option.none(),
  };
}

const cleanups: Array<() => void> = [];
beforeEach(() => useUiStateStore.setState(parsePersistedState({})));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useUiStateStore.setState(parsePersistedState({}));
});

function harness() {
  const registry = AtomRegistry.make();
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
  const shells = Atom.family((_id: EnvironmentId) => Atom.make(shell("empty")));
  let stop = subscribeToUnvisitedCompletions({ registry, catalogAtom: catalog, shellAtom: shells });
  cleanups.push(() => {
    stop();
    registry.dispose();
  });
  return {
    registry,
    shells,
    catalog,
    connect(ids: ReadonlyArray<EnvironmentId>) {
      registry.set(catalog, {
        isReady: true,
        entries: new Map(
          ids.map((environmentId) => [
            environmentId,
            {
              target: new PrimaryConnectionTarget({
                environmentId,
                label: environmentId,
                httpBaseUrl: "https://fixture.example.test",
                wsBaseUrl: "wss://fixture.example.test",
              }),
              profile: Option.none(),
            },
          ]),
        ),
      });
    },
    emit(status: EnvironmentShellState["status"], value = snapshot(), id = LOCAL) {
      registry.set(shells(id), shell(status, value));
    },
    restart() {
      stop();
      stop = subscribeToUnvisitedCompletions({ registry, catalogAtom: catalog, shellAtom: shells });
    },
    stop() {
      stop();
    },
  };
}

function key(environmentId = LOCAL) {
  return scopedThreadKey(scopeThreadRef(environmentId, INITIAL.id));
}
function unread(value = thread(), environmentId = LOCAL) {
  return hasUnseenCompletion({
    ...value,
    lastVisitedAt: useUiStateStore.getState().threadLastVisitedAtById[key(environmentId)],
  });
}

describe("unvisited completion observation", () => {
  it.effect.each([true, false])(
    "observes the actual shell runtime with completion-marker support=%s",
    (supportsCompletionMarker) =>
      Effect.gen(function* () {
        const client = harness();
        client.connect([LOCAL]);
        const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
        const subscribed = yield* Queue.unbounded<{
          afterSequence?: number;
          requestCompletionMarker?: boolean;
        }>();
        const applied = yield* Queue.unbounded<EnvironmentShellState>();
        const protocol = {
          [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: {
            afterSequence?: number;
            requestCompletionMarker?: boolean;
          }) =>
            Stream.unwrap(Queue.offer(subscribed, input).pipe(Effect.as(Stream.fromQueue(events)))),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client: protocol,
          initialConfig: Effect.succeed({
            shellResumeCompletionMarker: supportsCompletionMarker,
          } as ServerConfig),
          subscribeServerConfig: () => Stream.empty,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const target = new PrimaryConnectionTarget({
          environmentId: LOCAL,
          label: "Fixture",
          httpBaseUrl: "https://fixture.example.test",
          wsBaseUrl: "wss://fixture.example.test",
        });
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            stage: null,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
            Option.some({
              environmentId: LOCAL,
              label: "Fixture",
              httpBaseUrl: target.httpBaseUrl,
              socketUrl: target.wsBaseUrl,
              httpAuthorization: null,
              target,
            }),
          ),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const cache = EnvironmentCacheStore.of({
          loadShell: () =>
            Effect.succeed(Option.some(snapshot([thread("2026-09-05T07:00:00.000Z")]))),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        });
        const runtime = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.provideService(EnvironmentCacheStore, cache),
          Effect.provideService(
            ShellSnapshotLoader,
            ShellSnapshotLoader.of({
              load: () => Effect.succeed(Option.some(snapshot([thread()]))),
            }),
          ),
        );
        yield* SubscriptionRef.changes(runtime).pipe(
          Stream.runForEach((value) =>
            Effect.sync(() => client.registry.set(client.shells(LOCAL), value)).pipe(
              Effect.andThen(Queue.offer(applied, value)),
            ),
          ),
          Effect.forkScoped,
        );
        const input = yield* Queue.take(subscribed);
        expect(input.afterSequence).toBe(28);
        expect(input.requestCompletionMarker === true).toBe(supportsCompletionMarker);
        if (supportsCompletionMarker) yield* Queue.offer(events, { kind: "synchronized" });
        yield* Stream.fromQueue(applied).pipe(
          Stream.filter((value) => value.status === "live"),
          Stream.runHead,
        );
        expect(unread()).toBe(false);
        yield* Queue.offer(events, {
          kind: "thread-upserted",
          sequence: 35,
          thread: thread(null, "running"),
        });
        yield* Queue.offer(events, {
          kind: "thread-upserted",
          sequence: 37,
          thread: thread(LATER_COMPLETION),
        });
        yield* Stream.fromQueue(applied).pipe(
          Stream.filter(
            (value) =>
              Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === 37,
          ),
          Stream.runHead,
        );
        expect(unread(thread(LATER_COMPLETION))).toBe(true);
      }),
  );

  it("marks the actual create/running/completed receipt sequence unread for both sidebar selectors", () => {
    const client = harness();
    client.connect([LOCAL]);
    let current = snapshot();
    client.emit("live", current);
    for (const event of [
      { kind: "thread-upserted", sequence: 29, thread: INITIAL },
      { kind: "thread-upserted", sequence: 35, thread: thread(null, "running") },
      { kind: "thread-upserted", sequence: 37, thread: thread() },
    ] as const) {
      current = applyShellStreamEvent(current, event);
      client.emit("live", current);
    }
    expect(unread()).toBe(true);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key()]).toBe(
      "2026-09-05T08:00:12.789Z",
    );
    expect(
      resolveThreadStatusPill({
        thread: {
          ...thread(),
          lastVisitedAt: useUiStateStore.getState().threadLastVisitedAtById[key()],
        },
      })?.label,
    ).toBe("Completed");
  });

  it.each([COMPLETED_AT, "2026-09-05T08:03:00.000Z"])(
    "marks first-discovered completed threads independently of updatedAt=%s",
    (updatedAt) => {
      const client = harness();
      client.connect([LOCAL]);
      client.emit("live");
      client.emit("live", snapshot([{ ...thread(), updatedAt }]));
      expect(unread()).toBe(true);
    },
  );

  it("leaves historical first-live completions read but marks a later turn unread", () => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("live", snapshot([thread()]));
    expect(unread()).toBe(false);
    client.emit("live", snapshot([{ ...thread(), title: "Renamed" }]));
    expect(unread()).toBe(false);
    client.emit("live", snapshot([thread(LATER_COMPLETION)]));
    expect(unread(thread(LATER_COMPLETION))).toBe(true);
  });

  it("ignores cached and synchronizing history until the first live snapshot", () => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("cached", snapshot([thread()]));
    client.emit("synchronizing", snapshot([thread(LATER_COMPLETION)]));
    client.emit("live", snapshot([thread(LATER_COMPLETION)]));
    expect(unread(thread(LATER_COMPLETION))).toBe(false);
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
  });

  it("tracks a running thread in the first live snapshot until it completes", () => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("live", snapshot([thread(null, "running")]));
    client.emit("live", snapshot([thread()]));
    expect(unread()).toBe(true);
  });

  it("observes a hosted client with only saved remote environments", () => {
    const client = harness();
    client.registry.set(client.catalog, {
      isReady: true,
      entries: new Map([
        [
          REMOTE,
          {
            target: new BearerConnectionTarget({
              environmentId: REMOTE,
              label: "Saved remote",
              connectionId: "fixture-remote",
            }),
            profile: Option.none(),
          },
        ],
      ]),
    });
    client.emit("live", snapshot([thread(null, "running")]), REMOTE);
    client.emit("live", snapshot([thread()]), REMOTE);
    expect(unread(thread(), REMOTE)).toBe(true);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key(LOCAL)]).toBeUndefined();
  });

  it("retains the live baseline across disconnect and authoritative reconnect snapshots", () => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("live", snapshot([thread(null, "running")]));
    client.emit("cached", snapshot([thread(null, "running")]));
    client.emit("synchronizing", snapshot([thread()]));
    expect(unread()).toBe(false);
    client.emit("live", snapshot([thread()]));
    expect(unread()).toBe(true);
  });

  it("keeps environments independent and rebaselines removed/re-added environments", () => {
    const client = harness();
    client.connect([LOCAL, REMOTE]);
    client.emit("live");
    client.emit("live", snapshot([thread()]), REMOTE);
    expect(unread(thread(), REMOTE)).toBe(false);
    client.emit("live", snapshot([thread()]));
    expect(unread()).toBe(true);
    client.connect([LOCAL]);
    client.emit("live", snapshot([thread(LATER_COMPLETION)]), REMOTE);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key(REMOTE)]).toBeUndefined();
    client.connect([LOCAL, REMOTE]);
    expect(unread(thread(LATER_COMPLETION), REMOTE)).toBe(false);
    client.emit("live", snapshot([thread("2026-09-05T08:04:00.000Z")]), REMOTE);
    expect(unread(thread("2026-09-05T08:04:00.000Z"), REMOTE)).toBe(true);
  });

  it.each(["2026-09-05T08:00:00.000Z", COMPLETED_AT, "2026-09-05T08:03:00.000Z"])(
    "never overwrites a recorded visit at %s",
    (visitedAt) => {
      const client = harness();
      client.connect([LOCAL]);
      client.emit("live");
      useUiStateStore.getState().markThreadVisited(key(), visitedAt);
      client.emit("live", snapshot([thread()]));
      expect(useUiStateStore.getState().threadLastVisitedAtById[key()]).toBe(visitedAt);
    },
  );

  it("persists unread through reload and lets real visits and manual unread retain control", () => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("live");
    client.emit("live", snapshot([thread()]));
    useUiStateStore.setState(
      parsePersistedState(JSON.parse(JSON.stringify(useUiStateStore.getState()))),
    );
    client.restart();
    expect(unread()).toBe(true);
    useUiStateStore.getState().markThreadVisited(key(), COMPLETED_AT);
    client.emit("live", snapshot([{ ...thread(), title: "Renamed after reading" }]));
    expect(unread()).toBe(false);
    useUiStateStore.getState().markThreadUnread(key(), COMPLETED_AT);
    client.emit("live", snapshot([{ ...thread(), updatedAt: LATER_COMPLETION }]));
    expect(unread()).toBe(true);
  });

  it.each(["interrupted", "error"] as const)("does not mark %s turns completed-unread", (state) => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("live");
    client.emit("live", snapshot([thread(COMPLETED_AT, state)]));
    expect(unread(thread(COMPLETED_AT, state))).toBe(false);
  });

  it("disposes subscriptions without changing future completion state", () => {
    const client = harness();
    client.connect([LOCAL]);
    client.emit("live");
    client.stop();
    client.emit("live", snapshot([thread()]));
    expect(unread()).toBe(false);
  });
});
