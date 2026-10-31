import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  INITIAL_NEW_TASK_FLOW_STATE,
  newTaskFlowKey,
  newTaskFlowStateAtom,
  pruneNewTaskFlowStates,
  readNewTaskFlowState,
  resolveRouteDraft,
  stampedEnvironmentProjectsLoading,
  updateNewTaskFlowState,
} from "./new-task-flow-state";

function draftRoute(key: string, draftId: string) {
  return { key, name: "Thread", params: { draft: { draftId } } };
}

describe("new task flow state", () => {
  it("keeps a covered draft route's flow while another draft route is pushed above it", () => {
    const routeA = draftRoute("route-a", "draft-a");
    const routeB = draftRoute("route-b", "draft-b");
    const flowA = newTaskFlowKey(routeA)!;
    const flowB = newTaskFlowKey(routeB)!;

    // The provider subscribes to A, writes its selection, then moves to B.
    const unmountA = appAtomRegistry.mount(newTaskFlowStateAtom(flowA));
    updateNewTaskFlowState(flowA, { projectKey: "env:project-a", draftKey: "draft-a" });
    unmountA();
    const unmountB = appAtomRegistry.mount(newTaskFlowStateAtom(flowB));
    pruneNewTaskFlowStates({ routes: [{ key: "home", name: "Home" }, routeA, routeB] });

    expect(readNewTaskFlowState(flowB)).toBe(INITIAL_NEW_TASK_FLOW_STATE);
    expect(appAtomRegistry.get(newTaskFlowStateAtom(flowA))).toMatchObject({
      projectKey: "env:project-a",
      draftKey: "draft-a",
    });

    // Popping B returns to A with its state intact.
    unmountB();
    pruneNewTaskFlowStates({ routes: [{ key: "home", name: "Home" }, routeA] });
    expect(readNewTaskFlowState(flowA).projectKey).toBe("env:project-a");
  });

  it("drops a flow when its route is popped or promoted to a live thread", () => {
    const routeA = draftRoute("route-a", "draft-a");
    const routeB = draftRoute("route-b", "draft-b");
    updateNewTaskFlowState(newTaskFlowKey(routeA)!, { projectKey: "env:project-a" });
    updateNewTaskFlowState(newTaskFlowKey(routeB)!, { projectKey: "env:project-b" });

    pruneNewTaskFlowStates({
      routes: [{ key: "route-a", name: "Thread", params: { environmentId: "env", threadId: "t" } }],
    });

    expect(readNewTaskFlowState(newTaskFlowKey(routeA)!)).toBe(INITIAL_NEW_TASK_FLOW_STATE);
    expect(readNewTaskFlowState(newTaskFlowKey(routeB)!)).toBe(INITIAL_NEW_TASK_FLOW_STATE);
  });
});

describe("resolveRouteDraft", () => {
  const environmentId = EnvironmentId.make("env");
  const projectId = ProjectId.make("project");
  const stamp = { environmentId, projectId };
  const project = { environmentId, id: projectId };
  const base = {
    flow: INITIAL_NEW_TASK_FLOW_STATE,
    routeDraftId: "new-task:draft-1",
    draftsLoaded: true,
    stamp,
    projects: [project],
    stampedEnvironmentLoading: false,
  };

  it("binds the route's draft and its stamped project", () => {
    expect(resolveRouteDraft(base)).toEqual({
      kind: "open",
      flow: {
        ...INITIAL_NEW_TASK_FLOW_STATE,
        environmentId,
        projectKey: "env:project",
        draftKey: "new-task:draft-1",
      },
    });
  });

  it("leaves a flow that already bound a draft alone", () => {
    const flow = { ...INITIAL_NEW_TASK_FLOW_STATE, draftKey: "new-task:other" };
    expect(resolveRouteDraft({ ...base, flow })).toEqual({ kind: "none" });
  });

  it("waits for hydration, and for the stamped environment's projects", () => {
    expect(resolveRouteDraft({ ...base, draftsLoaded: false, stamp: undefined })).toEqual({
      kind: "pending",
    });
    expect(resolveRouteDraft({ ...base, projects: [], stampedEnvironmentLoading: true })).toEqual({
      kind: "pending",
    });
  });

  it("waits for a slower environment's projects while another environment's have loaded", () => {
    const environmentB = EnvironmentId.make("env-b");
    const projectB = { environmentId: environmentB, id: ProjectId.make("project-b") };
    const stampB = { environmentId: environmentB, projectId: projectB.id };

    expect(resolveRouteDraft({ ...base, stamp: stampB, stampedEnvironmentLoading: true })).toEqual({
      kind: "pending",
    });
    expect(
      resolveRouteDraft({ ...base, stamp: stampB, projects: [project, projectB] }),
    ).toMatchObject({ kind: "open", flow: { environmentId: environmentB } });
  });

  it("reports a draft that is gone or whose project is gone", () => {
    expect(resolveRouteDraft({ ...base, stamp: undefined })).toEqual({ kind: "missing" });
    expect(
      resolveRouteDraft({ ...base, projects: [{ environmentId, id: ProjectId.make("other") }] }),
    ).toEqual({ kind: "missing" });
  });
});

describe("stampedEnvironmentProjectsLoading", () => {
  const settled = {
    connectionsReady: true,
    connectionState: "connected" as const,
    shellCacheRead: true,
    shellStatus: "live" as const,
    shellHasError: false,
  };

  it("waits while the environment is still delivering its first project list", () => {
    expect(stampedEnvironmentProjectsLoading({ ...settled, connectionsReady: false })).toBe(true);
    expect(stampedEnvironmentProjectsLoading({ ...settled, shellCacheRead: false })).toBe(true);
    expect(stampedEnvironmentProjectsLoading({ ...settled, connectionState: "connecting" })).toBe(
      true,
    );
    expect(stampedEnvironmentProjectsLoading({ ...settled, shellStatus: "synchronizing" })).toBe(
      true,
    );
  });

  it("settles once the list is live, or when nothing more will arrive", () => {
    expect(stampedEnvironmentProjectsLoading(settled)).toBe(false);
    expect(stampedEnvironmentProjectsLoading({ ...settled, connectionState: null })).toBe(false);
    expect(
      stampedEnvironmentProjectsLoading({
        ...settled,
        connectionState: "reconnecting",
        shellStatus: "synchronizing",
      }),
    ).toBe(false);
    expect(stampedEnvironmentProjectsLoading({ ...settled, shellHasError: true })).toBe(false);
  });
});
