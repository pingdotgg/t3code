import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createTasksNavigationGuard,
  openOrbitAgentConversation,
  prepareOrbitConversationEnvironment,
  tasksNavigationPlace,
  type OrbitAgentNavigationPorts,
} from "./taskNavigation.logic";
import { tasksPanelActions, useTasksPanelStore } from "./tasksPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";

const origin = scopeThreadRef(EnvironmentId.make("origin"), ThreadId.make("origin-thread"));
const sameEnvironment = scopeThreadRef(
  origin.environmentId,
  ThreadId.make("canonical-agent-thread"),
);
const remote = scopeThreadRef(
  EnvironmentId.make("remote"),
  ThreadId.make("canonical-remote-thread"),
);

function setup() {
  useTasksPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  const sourceKey = scopedThreadKey(origin);
  tasksPanelActions().openTask(sourceKey, 482);
  tasksPanelActions().openSubtask(sourceKey, 484, "agents");
  tasksPanelActions().saveDetailScroll(sourceKey, 180);
  const navigated: string[] = [];
  const ports: OrbitAgentNavigationPorts = {
    source: origin,
    isCurrent: () => true,
    prepare: async () => {},
    handoff: (from, to) => {
      tasksPanelActions().handoff(scopedThreadKey(from), scopedThreadKey(to));
      useRightPanelStore.getState().open(to, "tasks");
    },
    navigate: async (target) => {
      navigated.push(scopedThreadKey(target));
    },
  };
  return { sourceKey, navigated, ports };
}

describe("Orbit task navigation", () => {
  it("uses the canonical target and preserves only Tasks across same/other-environment round trips", async () => {
    for (const target of [sameEnvironment, remote]) {
      const { ports, navigated, sourceKey } = setup();
      useRightPanelStore.getState().open(target, "files");
      const key = scopedThreadKey(target);
      await openOrbitAgentConversation(target, ports);
      expect(navigated).toEqual([key]);
      expect(useTasksPanelStore.getState().byThreadKey[key]).toMatchObject({
        taskId: 482,
        subtaskId: 484,
        tab: "agents",
        detailScrollTop: 180,
        originThreadKey: sourceKey,
      });
      expect(useRightPanelStore.getState().byThreadKey[key]?.surfaces.map((s) => s.kind)).toEqual([
        "files",
        "tasks",
      ]);
      const keptOrigin = useTasksPanelStore.getState().byThreadKey[sourceKey];
      tasksPanelActions().openSubtask(key, 483, "brief");
      await openOrbitAgentConversation(origin, { ...ports, source: target });
      expect(useTasksPanelStore.getState().byThreadKey[sourceKey]).toBe(keptOrigin);
    }
  });

  it("does not navigate or hand off when the environment cannot be prepared", async () => {
    const { ports, navigated } = setup();
    for (const message of ["Workspace asleep", "Environment unavailable", "Pairing refused"]) {
      await expect(
        openOrbitAgentConversation(remote, {
          ...ports,
          prepare: async () => {
            throw new Error(message);
          },
        }),
      ).rejects.toThrow(message);
    }
    expect(navigated).toEqual([]);
    expect(useTasksPanelStore.getState().byThreadKey[scopedThreadKey(remote)]).toBeUndefined();
  });

  it("does not finish an old click after the user leaves during pairing", async () => {
    const { ports, navigated } = setup();
    let release!: () => void;
    const paired = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const pairingStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let current = true;
    const opened = openOrbitAgentConversation(remote, {
      ...ports,
      isCurrent: () => current,
      prepare: () => {
        entered();
        return paired;
      },
    });
    await pairingStarted;
    current = false;
    release();
    await opened;
    expect(navigated).toEqual([]);
    expect(useTasksPanelStore.getState().byThreadKey[scopedThreadKey(remote)]).toBeUndefined();
  });

  it("drops a pending agent click once the user leaves its task or subtask, also for the board", async () => {
    const { ports, navigated } = setup();
    const guard = createTasksNavigationGuard();
    guard.enter("thread|482");
    let release!: () => void;
    const paired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stillHere = guard.begin();
    const opened = openOrbitAgentConversation(remote, {
      ...ports,
      isCurrent: stillHere,
      prepare: () => paired,
    });
    // Back to the board, then into another task, while the first agent's environment pairs.
    guard.leave();
    guard.enter("thread|board");
    guard.enter("thread|470");
    release();
    await opened;
    expect(navigated).toEqual([]);

    // A subtask's agent click is dropped when the path leads back up to its task.
    const subtask = tasksNavigationPlace("thread", { taskId: 482, subtaskId: 484 });
    const task = tasksNavigationPlace("thread", { taskId: 482, subtaskId: null });
    expect(subtask).not.toBe(task);
    expect(tasksNavigationPlace("thread", null)).toBe("thread|board");
    guard.enter(subtask);
    const fromSubtask = guard.begin();
    guard.enter(task);
    expect(fromSubtask()).toBe(false);

    // Staying on the same task keeps a click current; newer work replaces it.
    guard.enter("thread|470");
    const current = guard.begin();
    guard.enter("thread|470");
    expect(current()).toBe(true);
    guard.begin();
    expect(current()).toBe(false);
  });

  it("reuses the exact PR surface without losing Tasks selection", () => {
    const { sourceKey } = setup();
    useRightPanelStore.getState().open(origin, "tasks");
    const before = useTasksPanelStore.getState().byThreadKey[sourceKey];
    const pr = {
      environmentId: "remote",
      projectId: "repo-project",
      host: "github.com",
      repository: "nckrtl/conn",
      number: 127,
      url: "https://github.com/nckrtl/conn/pull/127",
    };
    useRightPanelStore.getState().openPullRequest(origin, pr);
    useRightPanelStore.getState().openPullRequest(origin, pr);
    const panel = useRightPanelStore.getState().byThreadKey[sourceKey]!;
    expect(panel.surfaces.filter((s) => s.kind === "pull-request")).toHaveLength(1);
    expect(panel.surfaces.find((s) => s.kind === "pull-request")).toMatchObject(pr);
    useRightPanelStore.getState().open(origin, "tasks");
    expect(useTasksPanelStore.getState().byThreadKey[sourceKey]).toBe(before);
  });
  it("pairs only a requested authorized environment and refuses stopped or missing destinations", async () => {
    let known = false;
    let paired = 0;
    let enabled = 0;
    const running = {
      environmentId: remote.environmentId,
      powerState: "running" as const,
      registeredAt: null,
    };
    const ports = {
      known: () => known,
      environments: async () => [running],
      connect: async () => {
        paired++;
        known = true;
        return true;
      },
      enable: async () => {
        enabled++;
      },
    };
    await prepareOrbitConversationEnvironment(remote.environmentId, ports);
    await prepareOrbitConversationEnvironment(remote.environmentId, ports);
    expect({ paired, enabled }).toEqual({ paired: 1, enabled: 2 });
    await expect(
      prepareOrbitConversationEnvironment(remote.environmentId, {
        ...ports,
        environments: async () => [{ ...running, powerState: "stopped" }],
      }),
    ).rejects.toThrow("asleep");
    known = false;
    await expect(
      prepareOrbitConversationEnvironment(remote.environmentId, {
        ...ports,
        environments: async () => [],
      }),
    ).rejects.toThrow("no longer available");
    await expect(
      prepareOrbitConversationEnvironment(remote.environmentId, {
        ...ports,
        connect: async () => false,
      }),
    ).rejects.toThrow("Could not pair");
    known = true;
    await prepareOrbitConversationEnvironment(origin.environmentId, {
      ...ports,
      environments: null,
    });
    expect(enabled).toBe(3);
  });
});
