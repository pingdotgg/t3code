import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { serverTabKey, useWorkspaceTabsStore, type WorkspaceTab } from "./workspaceTabsStore";

const envId = EnvironmentId.make("env-local");
const projId = ProjectId.make("project-1");
const thread1Id = ThreadId.make("thread-1");
const thread2Id = ThreadId.make("thread-2");
const thread3Id = ThreadId.make("thread-3");

function createServerTab(id: ThreadId, title = `Thread ${id}`): WorkspaceTab {
  return {
    key: serverTabKey(envId, id),
    kind: "server",
    environmentId: envId,
    threadId: id,
    title,
    projectId: projId,
    projectName: "My Project",
  };
}

describe("workspaceTabsStore", () => {
  beforeEach(() => {
    useWorkspaceTabsStore.setState({ tabs: [], activeTabKey: null });
  });

  it("opens a new tab and sets it active", () => {
    const tab1 = createServerTab(thread1Id);
    useWorkspaceTabsStore.getState().openTab(tab1);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.key).toBe(tab1.key);
    expect(state.activeTabKey).toBe(tab1.key);
  });

  it("updates existing tab title without creating duplicate", () => {
    const tab1 = createServerTab(thread1Id, "Initial Title");
    useWorkspaceTabsStore.getState().openTab(tab1);

    const tab1Updated = createServerTab(thread1Id, "Updated Title");
    useWorkspaceTabsStore.getState().openTab(tab1Updated);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.title).toBe("Updated Title");
    expect(state.activeTabKey).toBe(tab1.key);
  });

  it("prepends new tabs at the beginning", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);
    const tab3 = createServerTab(thread3Id);

    useWorkspaceTabsStore.getState().openTab(tab1);
    useWorkspaceTabsStore.getState().openTab(tab2);
    useWorkspaceTabsStore.getState().openTab(tab3);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([tab3.key, tab2.key, tab1.key]);
  });

  it("closes inactive tab without changing active tab", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);

    useWorkspaceTabsStore.getState().openTab(tab1);
    useWorkspaceTabsStore.getState().openTab(tab2);

    const nextActive = useWorkspaceTabsStore.getState().closeTab(tab1.key);
    expect(nextActive).toBeNull();

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabKey).toBe(tab2.key);
  });

  it("closes active tab and selects adjacent tab", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);
    const tab3 = createServerTab(thread3Id);

    useWorkspaceTabsStore.getState().openTab(tab1);
    useWorkspaceTabsStore.getState().openTab(tab2);
    useWorkspaceTabsStore.getState().openTab(tab3);
    useWorkspaceTabsStore.getState().openTab(tab2);

    const nextActive = useWorkspaceTabsStore.getState().closeTab(tab2.key);
    expect(nextActive?.key).toBe(tab1.key);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([tab3.key, tab1.key]);
    expect(state.activeTabKey).toBe(tab1.key);
  });

  it("closes active tab when closing last tab in list", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);

    useWorkspaceTabsStore.getState().openTab(tab2);
    useWorkspaceTabsStore.getState().openTab(tab1);

    const nextActive = useWorkspaceTabsStore.getState().closeTab(tab1.key);
    expect(nextActive?.key).toBe(tab2.key);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([tab2.key]);
    expect(state.activeTabKey).toBe(tab2.key);
  });

  it("closes other tabs preserving keepTabKey", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);
    const tab3 = createServerTab(thread3Id);

    useWorkspaceTabsStore.getState().openTab(tab1);
    useWorkspaceTabsStore.getState().openTab(tab2);
    useWorkspaceTabsStore.getState().openTab(tab3);

    useWorkspaceTabsStore.getState().closeOtherTabs(tab2.key);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.key).toBe(tab2.key);
    expect(state.activeTabKey).toBe(tab2.key);
  });

  it("closes tabs to the right", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);
    const tab3 = createServerTab(thread3Id);

    useWorkspaceTabsStore.getState().openTab(tab1);
    useWorkspaceTabsStore.getState().openTab(tab2);
    useWorkspaceTabsStore.getState().openTab(tab3);

    useWorkspaceTabsStore.getState().closeTabsToRight(tab2.key);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([tab3.key, tab2.key]);
  });

  it("reorders tabs correctly", () => {
    const tab1 = createServerTab(thread1Id);
    const tab2 = createServerTab(thread2Id);
    const tab3 = createServerTab(thread3Id);

    useWorkspaceTabsStore.getState().openTab(tab1);
    useWorkspaceTabsStore.getState().openTab(tab2);
    useWorkspaceTabsStore.getState().openTab(tab3);

    useWorkspaceTabsStore.getState().reorderTabs(tab3.key, tab1.key);

    const state = useWorkspaceTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([tab2.key, tab1.key, tab3.key]);
  });

  it("toggles pin status on tab", () => {
    const tab1 = createServerTab(thread1Id);
    useWorkspaceTabsStore.getState().openTab(tab1);

    useWorkspaceTabsStore.getState().togglePinTab(tab1.key);
    expect(useWorkspaceTabsStore.getState().tabs[0]?.pinned).toBe(true);

    useWorkspaceTabsStore.getState().togglePinTab(tab1.key);
    expect(useWorkspaceTabsStore.getState().tabs[0]?.pinned).toBe(false);
  });
});
