import { describe, expect, it } from "@effect/vitest";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { RelayAgentActivitySnapshotResponse } from "@t3tools/contracts/relay";
import { vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { AgentActivityRowProps } from "../../widgets/AgentActivity";
import {
  createLiveWidgetActivitiesAtom,
  reconcileWidgetActivity,
  retainUnconfirmedWidgetActivities,
} from "./liveWidgetActivity";

const ENVIRONMENT = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const NOW = "2026-09-05T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const project: OrchestrationProjectShell = {
  id: ProjectId.make("project"),
  title: "Project",
  workspaceRoot: "/synthetic/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread"),
    projectId: project.id,
    title: "Task",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function session(status: NonNullable<OrchestrationThreadShell["session"]>["status"]) {
  return {
    threadId: ThreadId.make("thread"),
    status,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function shell(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  status: EnvironmentShellState["status"] = "live",
): EnvironmentShellState {
  return {
    status,
    error: Option.none(),
    snapshot: Option.some({ projects: [project], threads, snapshotSequence: 1, updatedAt: NOW }),
  };
}

function harness(initial: EnvironmentShellState, now = () => NOW_MS) {
  const registry = AtomRegistry.make();
  const shellAtoms = Atom.family((_id: EnvironmentId) => Atom.make(initial));
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [
        ENVIRONMENT,
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT,
            label: "Local",
            httpBaseUrl: "https://local.example.test",
            wsBaseUrl: "wss://local.example.test/ws",
          }),
          profile: Option.none(),
        },
      ],
    ]),
  });
  const atom = createLiveWidgetActivitiesAtom({
    catalogValueAtom: catalog,
    shellStateValueAtom: shellAtoms,
    now,
  });
  return { registry, atom, catalog, shellAtoms };
}

function row(
  environmentId = REMOTE,
  threadId = ThreadId.make("remote-thread"),
  phase: AgentActivityRowProps["phase"] = "running",
) {
  return {
    environmentId,
    threadId,
    projectTitle: "Project",
    threadTitle: "Task",
    modelTitle: "test-model",
    phase,
    status: phase === "completed" ? "Done" : "Working",
    updatedAt: NOW,
    deepLink: `/threads/${environmentId}/${threadId}`,
  };
}

function snapshot(
  activities: NonNullable<RelayAgentActivitySnapshotResponse["aggregate"]>["activities"],
  activeCount = activities.filter(
    (value) => value.phase !== "completed" && value.phase !== "failed",
  ).length,
): RelayAgentActivitySnapshotResponse {
  return {
    aggregate: {
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount,
      updatedAt: NOW,
      activities,
    },
  };
}

describe("live widget activity", () => {
  it("expires terminal rows without a catalog or shell update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const h = harness(shell([thread({ session: session("ready") })]), Date.now);
    const stop = h.registry.mount(h.atom);
    try {
      expect(
        h.registry
          .get(h.atom)
          .get(ENVIRONMENT)
          ?.map((row) => row.phase),
      ).toEqual(["completed"]);
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      expect(h.registry.get(h.atom).get(ENVIRONMENT)).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
      vi.useRealTimers();
    }
  });

  it("observes local starts, completion, and deletion without a relay refresh", () => {
    const h = harness(shell([]));
    const seen: string[][] = [];
    const stop = h.registry.subscribe(
      h.atom,
      (live) => {
        seen.push((live.get(ENVIRONMENT) ?? []).map((value) => value.phase));
      },
      { immediate: true },
    );
    try {
      h.registry.set(h.shellAtoms(ENVIRONMENT), shell([thread({ session: session("starting") })]));
      h.registry.set(h.shellAtoms(ENVIRONMENT), shell([thread({ session: session("running") })]));
      h.registry.set(h.shellAtoms(ENVIRONMENT), shell([thread({ session: session("ready") })]));
      h.registry.set(h.shellAtoms(ENVIRONMENT), shell([]));
      expect(seen).toEqual([[], ["starting"], ["running"], ["completed"], []]);
      expect(h.registry.get(h.atom).has(ENVIRONMENT)).toBe(true);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it.each(["cached", "synchronizing", "empty"] as const)(
    "does not claim authority from %s shells",
    (status) => {
      const h = harness(shell([thread({ session: session("running") })], status));
      try {
        expect(h.registry.get(h.atom).has(ENVIRONMENT)).toBe(false);
        h.registry.set(h.shellAtoms(ENVIRONMENT), shell([]));
        expect(h.registry.get(h.atom).get(ENVIRONMENT)).toEqual([]);
        h.registry.set(
          h.shellAtoms(ENVIRONMENT),
          shell([thread({ session: session("running") })], status),
        );
        expect(h.registry.get(h.atom).has(ENVIRONMENT)).toBe(false);
      } finally {
        h.registry.dispose();
      }
    },
  );

  it("drops ownership when the environment is removed", () => {
    const h = harness(shell([thread({ session: session("running") })]));
    try {
      expect(h.registry.get(h.atom).size).toBe(1);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.atom).size).toBe(0);
    } finally {
      h.registry.dispose();
    }
  });

  it("keeps current attention and recent failures, not old completed history or orphan threads", () => {
    const h = harness(
      shell([
        thread({ id: ThreadId.make("approval"), hasPendingApprovals: true }),
        thread({ id: ThreadId.make("input"), hasPendingUserInput: true }),
        thread({ id: ThreadId.make("failure"), session: session("error") }),
        thread({
          id: ThreadId.make("old"),
          session: session("ready"),
          updatedAt: "2026-09-05T11:00:00.000Z",
        }),
        thread({
          id: ThreadId.make("orphan"),
          projectId: ProjectId.make("missing"),
          session: session("running"),
        }),
      ]),
    );
    try {
      expect(
        h.registry
          .get(h.atom)
          .get(ENVIRONMENT)
          ?.map((value) => value.status),
      ).toEqual(["Approval", "Input", "Failed"]);
    } finally {
      h.registry.dispose();
    }
  });

  it("replaces an entire live environment, including its idle and deleted threads", () => {
    const relay = snapshot([row(ENVIRONMENT), row()]);
    const live = new Map<EnvironmentId, ReadonlyArray<AgentActivityRowProps>>([[ENVIRONMENT, []]]);
    expect(reconcileWidgetActivity(live, relay)).toEqual({ activeCount: 1, activities: [row()] });
    live.set(ENVIRONMENT, [row(ENVIRONMENT, ThreadId.make("different-task"))]);
    expect(reconcileWidgetActivity(live, relay).activeCount).toBe(2);
    expect(reconcileWidgetActivity(live, relay).activities.map((value) => value.threadId)).toEqual([
      "different-task",
      "remote-thread",
    ]);
  });

  it("counts all local work before capping displayed rows", () => {
    const localRows = Array.from({ length: 8 }, (_, index) =>
      row(ENVIRONMENT, ThreadId.make(`local-${index}`)),
    );
    const result = reconcileWidgetActivity(new Map([[ENVIRONMENT, localRows]]), snapshot([row()]));
    expect(result.activeCount).toBe(9);
    expect(result.activities).toHaveLength(5);
  });

  it("does not turn an incomplete legacy count into an exact mixed count", () => {
    const relay = snapshot(
      Array.from({ length: 5 }, (_, index) => row(REMOTE, ThreadId.make(`remote-${index}`))),
      12,
    );
    expect(reconcileWidgetActivity(new Map(), relay).activeCount).toBe(12);
    expect(reconcileWidgetActivity(new Map([[ENVIRONMENT, []]]), relay).activeCount).toBeNull();
    expect(
      reconcileWidgetActivity(new Map([[ENVIRONMENT, [row(ENVIRONMENT)]]]), relay).activeCount,
    ).toBeNull();
  });

  it("distinguishes an unread relay snapshot from a confirmed empty one", () => {
    const live = new Map([[ENVIRONMENT, [row(ENVIRONMENT)]]]);
    expect(reconcileWidgetActivity(live, null).activeCount).toBeNull();
    expect(reconcileWidgetActivity(live, { aggregate: null }).activeCount).toBe(1);
  });

  it("uses an acknowledged matching exclusion scope even when remote activity is capped", () => {
    const live = new Map([[ENVIRONMENT, [row(ENVIRONMENT)]]]);
    const filtered = { ...snapshot([row()], 12), excludedEnvironmentIds: [ENVIRONMENT] };
    expect(reconcileWidgetActivity(live, filtered).activeCount).toBe(13);
    expect(reconcileWidgetActivity(new Map(), filtered).activeCount).toBeNull();
    expect(reconcileWidgetActivity(new Map([[REMOTE, []]]), filtered).activeCount).toBeNull();
  });

  it("does not validate retained work with omission or equal-timestamp conflicting phases", () => {
    const observed = new Map([
      [ENVIRONMENT, [row(ENVIRONMENT, ThreadId.make("task"), "completed")]],
    ]);
    const stale = snapshot([row(ENVIRONMENT, ThreadId.make("task"))]);
    expect(retainUnconfirmedWidgetActivities(observed, new Map(), observed, stale)).toEqual(
      observed,
    );
    expect(
      retainUnconfirmedWidgetActivities(observed, new Map(), observed, { aggregate: null }),
    ).toEqual(observed);
    const matching = snapshot(observed.get(ENVIRONMENT)!);
    expect(retainUnconfirmedWidgetActivities(observed, new Map(), observed, matching).size).toBe(0);
    expect(retainUnconfirmedWidgetActivities(observed, observed, observed, matching)).toEqual(
      observed,
    );
  });

  it("accepts a newer relay observation but cannot retire local changes made during the read", () => {
    const observed = new Map([[ENVIRONMENT, [row(ENVIRONMENT)]]]);
    const newer = snapshot([
      {
        ...row(ENVIRONMENT, ThreadId.make("remote-thread"), "completed"),
        updatedAt: "2026-09-05T12:00:01.000Z",
      },
    ]);
    expect(retainUnconfirmedWidgetActivities(observed, new Map(), observed, newer).size).toBe(0);
    const changed = new Map([[ENVIRONMENT, [row(ENVIRONMENT)]]]);
    expect(retainUnconfirmedWidgetActivities(changed, new Map(), observed, newer)).toEqual(changed);
  });

  it("only validates empty observations when no active rows can be hidden by the cap", () => {
    const observed = new Map([[ENVIRONMENT, []]]);
    expect(
      retainUnconfirmedWidgetActivities(observed, new Map(), observed, snapshot([row()], 12)),
    ).toEqual(observed);
    expect(
      retainUnconfirmedWidgetActivities(observed, new Map(), observed, snapshot([row()])).size,
    ).toBe(0);
    expect(
      retainUnconfirmedWidgetActivities(observed, new Map(), observed, {
        aggregate: null,
        excludedEnvironmentIds: [ENVIRONMENT],
      }),
    ).toEqual(observed);
  });
});
