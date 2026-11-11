import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type PullRequestRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { Activity, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  environment: undefined as EnvironmentRegistry.EnvironmentRegistry["Service"] | undefined,
  active: "active",
  listeners: new Set<() => void>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return fixture.active;
    },
    addEventListener: (_event: string, listener: () => void) => {
      fixture.listeners.add(listener);
      return { remove: () => fixture.listeners.delete(listener) };
    },
  },
}));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.suspend(() =>
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, fixture.environment!),
      ),
    ),
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make({ environment: { capabilities: { threadPullRequests: true } } });
  return { serverEnvironment: { configValueAtom: () => config } };
});

import { ThreadPrDemandProvider } from "./thread-pr-demand";
import { useThreadPr } from "./use-thread-pr";

const environmentId = EnvironmentId.make("sidebar-environment");
const reference = {
  projectId: ProjectId.make("project"),
  repository: "acme/app",
  number: 12,
  url: "https://github.com/acme/app/pull/12",
};
function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make("thread"),
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: reference,
    ...overrides,
  } as EnvironmentThreadShell;
}

const setup = Effect.fn("TestThreadPr.setup")(function* () {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(0);
  fixture.active = "active";
  fixture.listeners.clear();
  const requests: Array<{ environmentId: EnvironmentId; input: PullRequestRef }> = [];
  let state = "open";
  let replyGate: Latch.Latch | null = null;
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Sidebar environment",
    httpBaseUrl: "https://sidebar.test",
    wsBaseUrl: "wss://sidebar.test",
  });
  const supervisor = yield* Effect.gen(function* () {
    return EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
        desired: true,
        network: "online" as const,
        attempt: 1,
        generation: 1,
      }),
      session: yield* SubscriptionRef.make(
        Option.some({
          client: {
            [WS_METHODS.pullRequestsSummary]: (input: PullRequestRef) =>
              Effect.gen(function* () {
                requests.push({ environmentId: currentEnvironment, input });
                if (replyGate !== null) yield* replyGate.await;
                return {
                  ...input,
                  provider: "github",
                  state,
                  title: `Change ${input.number}`,
                  url: `https://github.com/${input.repository}/pull/${input.number}`,
                  baseBranch: "main",
                  headBranch: "feature",
                  isDraft: false,
                  updatedAt: null,
                };
              }),
            [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
          },
          ready: Effect.void,
        } as unknown as RpcSession),
      ),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });
  let currentEnvironment = environmentId;
  const environment = {
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    run: (id, effect) => {
      currentEnvironment = id;
      return Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    },
    followStream: (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
  } satisfies Pick<
    EnvironmentRegistry.EnvironmentRegistry["Service"],
    "entries" | "run" | "followStream" | "stateChanges"
  >;
  fixture.environment =
    environment as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounts = 0;
  function Row({ value, name }: { value: EnvironmentThreadShell; name: string }) {
    const [passive] = useState(() => ++mounts);
    const pr = useThreadPr(value);
    return (
      <output data-name={name} data-passive={passive}>
        {pr?.accessibilityLabel ?? "none"}
      </output>
    );
  }
  return {
    requests,
    get mounts() {
      return mounts;
    },
    setState(next: string) {
      state = next;
    },
    holdReplies() {
      replyGate = Latch.makeUnsafe();
    },
    async releaseReplies() {
      await act(async () => {
        replyGate?.openUnsafe();
        replyGate = null;
      });
    },
    badge(name = "sidebar") {
      return container.querySelector(`output[data-name="${name}"]`)?.textContent;
    },
    passive() {
      return container.querySelector("output")?.getAttribute("data-passive");
    },
    async render({
      visible = true,
      value = thread(),
      shared = false,
      activity = "visible",
    }: {
      visible?: boolean;
      value?: EnvironmentThreadShell;
      shared?: boolean;
      activity?: "visible" | "hidden";
    } = {}) {
      await act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <Activity mode={activity}>
              <div hidden={!visible} style={{ width: 320 }}>
                <ThreadPrDemandProvider visible={visible}>
                  <Row value={value} name="sidebar" />
                </ThreadPrDemandProvider>
              </div>
            </Activity>
            {shared ? <Row value={thread({ id: ThreadId.make("shared") })} name="shared" /> : null}
          </RegistryContext>,
        ),
      );
    },
    async advance(ms: number) {
      await act(async () => vi.advanceTimersByTimeAsync(ms));
    },
    async appState(next: string) {
      await act(async () => {
        fixture.active = next;
        for (const listener of fixture.listeners) listener();
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      expect(fixture.listeners.size).toBe(0);
      vi.useRealTimers();
    },
  };
});

it.effect(
  "releases retained hidden sidebar demand and keeps the badge while reveal revalidates",
  () =>
    Effect.gen(function* () {
      using h = yield* setup();
      yield* Effect.promise(async () => {
        await h.render();
        expect(h.badge()).toBe("#12 pull request open");
        const passive = h.passive();
        expect(h.requests).toHaveLength(1);
        await h.render({ visible: false });
        await h.advance(10_000);
        const afterGrace = h.requests.length;
        await h.advance(180_000);
        expect(h.requests.length - afterGrace).toBe(0);
        expect(h.passive()).toBe(passive);
        h.holdReplies();
        h.setState("closed");
        await h.render();
        expect(h.badge()).toBe("#12 pull request open");
        expect(h.requests.length).toBe(afterGrace + 1);
        expect(h.mounts).toBe(1);
        await h.releaseReplies();
        expect(h.badge()).toBe("#12 pull request closed");
      });
    }),
);

it.effect("does not start a fallback query for a sidebar first mounted hidden", () =>
  Effect.gen(function* () {
    using h = yield* setup();
    yield* Effect.promise(async () => {
      await h.render({ visible: false });
      await h.advance(180_000);
      expect(h.requests).toHaveLength(0);
      expect(h.badge()).toBe("none");
      await h.render();
      expect(h.requests).toHaveLength(1);
      expect(h.badge()).toBe("#12 pull request open");
      expect(h.mounts).toBe(1);
    });
  }),
);

it.effect("keeps a shared visible reader polling while its sidebar reader is hidden", () =>
  Effect.gen(function* () {
    using h = yield* setup();
    yield* Effect.promise(async () => {
      await h.render({ shared: true });
      expect(h.requests).toHaveLength(1);
      await h.render({ visible: false, shared: true });
      await h.advance(180_000);
      expect(h.requests).toHaveLength(4);
      expect(h.badge("shared")).toBe("#12 pull request open");
      h.setState("closed");
      await h.advance(60_000);
      expect(h.requests).toHaveLength(5);
      expect(h.badge("shared")).toBe("#12 pull request closed");
      await h.render({ shared: true });
      expect(h.badge()).toBe("#12 pull request closed");
    });
  }),
);

it.effect.each(["inactive", "background"])("releases sidebar demand while the OS is %s", (state) =>
  Effect.gen(function* () {
    using h = yield* setup();
    yield* Effect.promise(async () => {
      await h.render();
      await h.appState(state);
      await h.advance(10_000);
      const before = h.requests.length;
      await h.advance(180_000);
      expect(h.requests.length - before).toBe(0);
      h.holdReplies();
      await h.appState("active");
      expect(h.badge()).toBe("#12 pull request open");
      expect(h.requests.length - before).toBe(1);
      expect(h.mounts).toBe(1);
    });
  }),
);

it.effect("keeps mounted passive state through an Android-style Activity tab switch", () =>
  Effect.gen(function* () {
    using h = yield* setup();
    yield* Effect.promise(async () => {
      await h.render();
      const passive = h.passive();
      await h.render({ activity: "hidden" });
      await h.advance(10_000);
      const before = h.requests.length;
      await h.advance(180_000);
      expect(h.requests.length - before).toBe(0);
      h.holdReplies();
      await h.render();
      expect(h.badge()).toBe("#12 pull request open");
      expect(h.passive()).toBe(passive);
      expect(h.mounts).toBe(1);
      expect(h.requests.length - before).toBe(1);
    });
  }),
);
