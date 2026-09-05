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
import { RegistryContext } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { act, createElement, Fragment, useEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { hasUnseenCompletion, resolveThreadStatusPill } from "../components/Sidebar.logic";
import { parsePersistedState, useUiStateStore } from "../uiStateStore";
import {
  subscribeToUnvisitedCompletions,
  useUnvisitedCompletionsUnread,
} from "./useUnvisitedCompletionsUnread";

// Only the network-fed atom values are supplied by the fixture. React effects,
// router navigation, Registry subscriptions, and persisted UI state are real.
const hookAtoms = vi.hoisted(() => ({
  catalog: null as Atom.Atom<EnvironmentCatalogState> | null,
  shell: null as ((id: EnvironmentId) => Atom.Atom<EnvironmentShellState>) | null,
}));
// Node otherwise selects TanStack's SSR export, which intentionally never
// subscribes React components to navigation. Exercise its client lifecycle.
vi.mock("@tanstack/router-core/isServer", () => ({ isServer: false }));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    get catalogValueAtom() {
      if (hookAtoms.catalog === null) throw new Error("Hook fixture not initialized");
      return hookAtoms.catalog;
    },
  },
}));
vi.mock("../state/shell", () => ({
  environmentShell: {
    stateValueAtom(id: EnvironmentId) {
      if (hookAtoms.shell === null) throw new Error("Hook fixture not initialized");
      return hookAtoms.shell(id);
    },
  },
}));

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
  // The network runtime owns these values independently of the observer's lifetime.
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: false,
    entries: new Map(),
  }).pipe(Atom.keepAlive);
  const shells = Atom.family((_id: EnvironmentId) =>
    Atom.make(shell("empty")).pipe(Atom.keepAlive),
  );
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

async function mountHookRouter(
  client: ReturnType<typeof harness>,
  initialEnabled = true,
  layout: "shell-only" | "persistent" = "persistent",
) {
  client.stop();
  hookAtoms.catalog = client.catalog;
  hookAtoms.shell = client.shells;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const browserEvents = new EventTarget();
  const documentEvents = new EventTarget();
  vi.stubGlobal(
    "window",
    Object.assign(browserEvents, {
      origin: "https://fixture.example.test",
      document: documentEvents,
    }),
  );
  vi.stubGlobal("self", browserEvents);
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("history", { scrollRestoration: "manual" });
  vi.stubGlobal("addEventListener", browserEvents.addEventListener.bind(browserEvents));
  vi.stubGlobal("scrollTo", () => undefined);
  let changeEnabled: (enabled: boolean) => void = () => {
    throw new Error("Root not mounted");
  };
  const lifetime = { mounts: 0, unmounts: 0 };
  function Observer({ enabled }: { enabled: boolean }) {
    useUnvisitedCompletionsUnread(enabled);
    return null;
  }
  function ShellOnlyLayout({ enabled, pathname }: { enabled: boolean; pathname: string }) {
    return pathname === "/connect"
      ? createElement(Outlet)
      : createElement(Fragment, null, createElement(Observer, { enabled }), createElement(Outlet));
  }
  function PersistentLayout({ enabled }: { enabled: boolean }) {
    useUnvisitedCompletionsUnread(enabled);
    return createElement(Outlet);
  }
  function Root() {
    const [enabled, setEnabled] = useState(initialEnabled);
    const pathname = useLocation({ select: (location) => location.pathname });
    useEffect(() => {
      changeEnabled = setEnabled;
      lifetime.mounts += 1;
      return () => {
        lifetime.unmounts += 1;
      };
    }, []);
    return layout === "shell-only"
      ? createElement(ShellOnlyLayout, { enabled, pathname })
      : createElement(PersistentLayout, { enabled });
  }
  const root = createRootRoute({ component: Root });
  const shellRoute = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const connectRoute = createRoute({
    getParentRoute: () => root,
    path: "/connect",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([shellRoute, connectRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await router.load();
  let renderer: ReactTestRenderer;
  await act(() => {
    renderer = create(
      createElement(
        RegistryContext.Provider,
        { value: client.registry },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  return {
    router,
    lifetime,
    enable: (enabled: boolean) => act(() => changeEnabled(enabled)),
    close: async () => {
      await act(() => renderer.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("unvisited completion observation", () => {
  it("retains the live hook baseline across shell-connect-shell navigation", async () => {
    const client = harness();
    const mounted = await mountHookRouter(client);
    try {
      await act(() => {
        client.connect([LOCAL]);
        client.emit("live", snapshot([thread(null, "running")]));
      });
      await act(() => mounted.router.navigate({ to: "/connect" }));
      expect(mounted.router.state.location.pathname).toBe("/connect");
      await act(() => client.emit("live", snapshot([thread()])));
      await act(() => mounted.router.navigate({ to: "/" }));
      expect(mounted.lifetime).toEqual({ mounts: 1, unmounts: 0 });
      expect(unread()).toBe(true);
    } finally {
      await mounted.close();
    }
  });

  it("demonstrates the old shell-only subtree losing completions on connect", async () => {
    const client = harness();
    const mounted = await mountHookRouter(client, true, "shell-only");
    try {
      await act(() => {
        client.connect([LOCAL]);
        client.emit("live", snapshot([thread(null, "running")]));
      });
      await act(() => mounted.router.navigate({ to: "/connect" }));
      await act(() => client.emit("live", snapshot([thread()])));
      await act(() => mounted.router.navigate({ to: "/" }));
      expect(mounted.lifetime).toEqual({ mounts: 1, unmounts: 0 });
      expect(unread()).toBe(false);
      expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
    } finally {
      await mounted.close();
    }
  });

  it("disables hook subscriptions and re-enables with a fresh historical baseline", async () => {
    const client = harness();
    const mounted = await mountHookRouter(client, false, "persistent");
    try {
      await act(() => {
        client.connect([LOCAL]);
        client.emit("live");
        client.emit("live", snapshot([thread()]));
      });
      expect(unread()).toBe(false);
      expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
      await mounted.enable(true);
      expect(unread()).toBe(false);
      await act(() => client.emit("live", snapshot([thread(LATER_COMPLETION)])));
      expect(unread(thread(LATER_COMPLETION))).toBe(true);
      const visits = useUiStateStore.getState().threadLastVisitedAtById;
      await mounted.enable(false);
      const newThread = { ...thread(), id: ThreadId.make("while-disabled") };
      await act(() => client.emit("live", snapshot([thread(LATER_COMPLETION), newThread])));
      expect(useUiStateStore.getState().threadLastVisitedAtById).toBe(visits);
      await mounted.enable(true);
      expect(useUiStateStore.getState().threadLastVisitedAtById).toBe(visits);
    } finally {
      await mounted.close();
    }
  });

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

  it.each([100, 1000])(
    "notifies once for %s new completions while preserving recorded visits",
    (count) => {
      const client = harness();
      client.connect([LOCAL]);
      client.emit("live");
      const read = { ...thread(), id: ThreadId.make("read-thread") };
      const manuallyUnread = { ...thread(), id: ThreadId.make("manual-unread-thread") };
      const readKey = scopedThreadKey(scopeThreadRef(LOCAL, read.id));
      const manualKey = scopedThreadKey(scopeThreadRef(LOCAL, manuallyUnread.id));
      const visits = {
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`old:${index}`, COMPLETED_AT]),
        ),
        [readKey]: LATER_COMPLETION,
        [manualKey]: "2026-09-05T08:00:12.785Z",
      };
      useUiStateStore.setState({ threadLastVisitedAtById: visits });
      let notifications = 0;
      cleanups.push(
        useUiStateStore.subscribe(() => {
          notifications += 1;
        }),
      );
      const completed = Array.from({ length: count }, (_, index) => ({
        ...thread(),
        id: ThreadId.make(`batch-${index}`),
      }));
      client.emit("live", snapshot([read, manuallyUnread, ...completed]));
      expect(notifications).toBe(1);
      const next = useUiStateStore.getState().threadLastVisitedAtById;
      expect(Object.keys(next)).toHaveLength(102 + count);
      expect(next[readKey]).toBe(LATER_COMPLETION);
      expect(next[manualKey]).toBe(visits[manualKey]);
      expect(next["old:99"]).toBe(COMPLETED_AT);
      expect(Object.keys(visits)).toHaveLength(102);
      for (const completedThread of completed) {
        expect(next[scopedThreadKey(scopeThreadRef(LOCAL, completedThread.id))]).toBe(
          "2026-09-05T08:00:12.789Z",
        );
      }
      client.emit("live", snapshot([read, manuallyUnread, ...completed]));
      expect(notifications).toBe(1);
      expect(useUiStateStore.getState().threadLastVisitedAtById).toBe(next);
    },
  );

  it("does not notify for historical, unchanged, or invalid completion timestamps", () => {
    const client = harness();
    client.connect([LOCAL]);
    const before = useUiStateStore.getState();
    let notifications = 0;
    cleanups.push(
      useUiStateStore.subscribe(() => {
        notifications += 1;
      }),
    );
    client.emit("live", snapshot([thread()]));
    client.emit("live", snapshot([{ ...thread(), title: "Renamed history" }]));
    client.emit("live", snapshot([thread("not-a-date")]));
    expect(notifications).toBe(0);
    expect(useUiStateStore.getState()).toBe(before);
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
