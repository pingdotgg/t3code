import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TASKS_NAVIGATION, useTasksPanelStore } from "./tasksPanelStore";

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
});
