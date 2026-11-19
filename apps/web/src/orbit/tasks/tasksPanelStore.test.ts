import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_TASKS_NAVIGATION,
  TASKS_NAVIGATION_THREAD_LIMIT,
  useTasksPanelStore,
} from "./tasksPanelStore";

const store = () => useTasksPanelStore.getState();
const at = (threadKey: string) => store().byThreadKey[threadKey] ?? DEFAULT_TASKS_NAVIGATION;

describe("tasksPanelStore", () => {
  it("restores the task, subtask, tab and scroll after the board, per thread", () => {
    store().saveBoardScroll("env:a", 120, 40);
    store().openTask("env:a", 482);
    store().openSubtask("env:a", 484, "agents");
    store().saveDetailScroll("env:a", 300);
    store().openTask("env:b", 431);

    store().showBoard("env:a");
    expect(at("env:a")).toMatchObject({ view: "board", boardScroll: { top: 120, left: 40 } });

    store().openTask("env:a", 482);
    expect(at("env:a")).toMatchObject({
      view: "task",
      taskId: 482,
      subtaskId: 484,
      tab: "agents",
      detailScrollTop: 300,
    });
    expect(at("env:b")).toMatchObject({ taskId: 431, subtaskId: null, tab: "brief" });
  });

  it("returns from a subtask to the task's own tab", () => {
    store().openTask("env:tabs", 482);
    store().openSubtask("env:tabs", 484);
    store().setTab("env:tabs", "agents");
    store().openSubtask("env:tabs", null);
    expect(at("env:tabs")).toMatchObject({ subtaskId: null, tab: "brief" });

    store().setTab("env:tabs", "agents");
    store().openSubtask("env:tabs", 484);
    store().setTab("env:tabs", "brief");
    store().openSubtask("env:tabs", 485, "agents");
    store().openSubtask("env:tabs", null);
    expect(at("env:tabs")).toMatchObject({ subtaskId: null, tab: "agents" });
  });

  it("opens a task's PR below the task and goes back up to the tab the task had open", () => {
    const pullRequest = {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      repository: "nckrtl/conn",
      number: 1931,
      url: "https://github.com/nckrtl/conn/pull/1931",
    };
    store().openTask("env:pr", 482);
    store().setTab("env:pr", "agents");
    store().openPullRequest("env:pr", 482, pullRequest);
    store().setPullRequestTab("env:pr", "timeline");
    expect(at("env:pr")).toMatchObject({
      taskId: 482,
      tab: "agents",
      pullRequest: { number: 1931, tab: "timeline" },
    });
    store().closePullRequest("env:pr");
    expect(at("env:pr")).toMatchObject({ taskId: 482, tab: "agents", pullRequest: null });

    // A board badge opens another task's PR on that task's brief; the card opens the task itself.
    store().showBoard("env:pr");
    store().openPullRequest("env:pr", 470, pullRequest);
    expect(at("env:pr")).toMatchObject({ view: "task", taskId: 470, tab: "brief" });
    store().showBoard("env:pr");
    store().openTask("env:pr", 470);
    expect(at("env:pr")).toMatchObject({ view: "task", taskId: 470, pullRequest: null });
  });

  it("opens the PR from a badge even when that task had a subtask open", () => {
    const pullRequest = {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      repository: "nckrtl/conn",
      number: 1931,
      url: "https://github.com/nckrtl/conn/pull/1931",
    };
    store().openTask("env:pr-sub", 482);
    store().setTab("env:pr-sub", "subtasks");
    store().openSubtask("env:pr-sub", 484, "agents");
    store().showBoard("env:pr-sub");
    store().openPullRequest("env:pr-sub", 482, pullRequest);
    expect(at("env:pr-sub")).toMatchObject({
      taskId: 482,
      subtaskId: null,
      tab: "subtasks",
      pullRequest: { number: 1931 },
    });
    store().closePullRequest("env:pr-sub");
    expect(at("env:pr-sub")).toMatchObject({ subtaskId: null, tab: "subtasks" });
  });

  it("opens a subtask from the Subtasks tab on its brief, and comes back to Subtasks", () => {
    store().openTask("env:subtasks", 482);
    store().setTab("env:subtasks", "subtasks");
    store().openSubtask("env:subtasks", 484);
    expect(at("env:subtasks")).toMatchObject({ subtaskId: 484, tab: "brief" });

    store().openSubtask("env:subtasks", null);
    expect(at("env:subtasks")).toMatchObject({ subtaskId: null, tab: "subtasks" });

    store().openSubtask("env:subtasks", 485, "agents");
    expect(at("env:subtasks")).toMatchObject({ subtaskId: 485, tab: "agents" });
  });

  it("opens a different task at its brief, from the top", () => {
    store().openTask("env:c", 482);
    store().openSubtask("env:c", 483, "agents");
    store().saveDetailScroll("env:c", 200);

    store().openTask("env:c", 470);
    expect(at("env:c")).toMatchObject({
      taskId: 470,
      subtaskId: null,
      tab: "brief",
      detailScrollTop: 0,
    });
  });

  it("keeps the content tab when moving between subtasks unless one is asked for", () => {
    store().openTask("env:d", 482);
    store().setTab("env:d", "agents");
    store().saveDetailScroll("env:d", 80);

    store().openSubtask("env:d", 483);
    expect(at("env:d")).toMatchObject({ subtaskId: 483, tab: "agents", detailScrollTop: 0 });

    store().openSubtask("env:d", null, "brief");
    expect(at("env:d")).toMatchObject({ subtaskId: null, tab: "brief" });

    const before = store().byThreadKey;
    store().openSubtask("env:d", null);
    store().saveDetailScroll("env:d", 0);
    expect(store().byThreadKey).toBe(before);
  });

  it("keeps only the threads changed most recently", () => {
    useTasksPanelStore.setState({ byThreadKey: {} });
    let now = 1_000;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now++);
    for (let index = 0; index < TASKS_NAVIGATION_THREAD_LIMIT; index += 1) {
      store().openTask(`env:cap-${index}`, index);
    }
    // Touching the oldest thread makes it recent, so the next oldest goes instead.
    store().saveDetailScroll("env:cap-0", 40);
    store().openTask("env:cap-new", 999);

    const keys = Object.keys(store().byThreadKey);
    expect(keys).toHaveLength(TASKS_NAVIGATION_THREAD_LIMIT);
    expect(keys).toContain("env:cap-0");
    expect(keys).toContain("env:cap-new");
    expect(keys).not.toContain("env:cap-1");
  });
  it("caps old persisted navigation when it is restored", async () => {
    const { name, storage } = useTasksPanelStore.persist.getOptions();
    if (!name || !storage) throw new Error("Missing navigation storage");
    const entries = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `old:${index}`,
        { ...DEFAULT_TASKS_NAVIGATION, taskId: index, updatedAt: 500 },
      ]),
    );
    useTasksPanelStore.setState({ byThreadKey: {} });
    await storage.setItem(name, { state: { byThreadKey: entries }, version: 1 });
    await useTasksPanelStore.persist.rehydrate();
    expect(Object.keys(store().byThreadKey)).toHaveLength(TASKS_NAVIGATION_THREAD_LIMIT);
    expect(Object.values(store().byThreadKey).every((entry) => entry.updatedAt === 0)).toBe(true);
  });
});
