import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, TaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import {
  resolveTaskCreateContext,
  resolveTaskCreateProject,
  taskCreateCommand,
  taskCreateProjects,
} from "./taskCreateContext";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const taskId = TaskId.make("task");
function project(environmentId: EnvironmentId): EnvironmentProject {
  return {
    environmentId,
    id: projectId,
    title: "T3",
    workspaceRoot: "/workspace/t3",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}
const localProject = project(local);
const remoteProject = project(remote);
const projects = [localProject, remoteProject];
const capableIds = new Set([local, remote]);
function scope(members: readonly EnvironmentProject[]) {
  return {
    key: "logical:t3",
    title: "T3",
    representative: members[0]!,
    projects: members,
    projectRefs: members.map((member) => ({
      environmentId: member.environmentId,
      projectId: member.id,
    })),
  };
}

const submitInput = { taskId, name: "  Ship it  ", description: "  Ready  " };

describe("native task creation context", () => {
  it("preselects a physical Home/sidebar project filter", () => {
    const physical = buildHomeProjectScopes({
      projects: [remoteProject],
      environmentId: null,
      projectGroupingMode: "separate",
    })[0]!;
    const context = resolveTaskCreateContext({
      environmentId: null,
      projectKey: physical.key,
      projectScope: physical,
    });
    expect(context).toEqual({ environmentId: remote, projectId });
    expect(resolveTaskCreateProject({ projects, context, selection: null })).toBe(remoteProject);
  });

  it("leaves All projects empty even with just one eligible project", () => {
    const context = resolveTaskCreateContext({
      environmentId: null,
      projectKey: null,
      projectScope: null,
    });
    expect(context).toEqual({});
    expect(
      resolveTaskCreateProject({ projects: [localProject], context, selection: null }),
    ).toBeNull();
    expect(taskCreateCommand({ ...submitInput, projects, context, selection: null })).toBeNull();
  });

  it("constrains an environment-only filter without picking its first project", () => {
    const context = resolveTaskCreateContext({
      environmentId: remote,
      projectKey: null,
      projectScope: null,
    });
    const eligible = taskCreateProjects({ projects, capableIds, context });
    expect(eligible).toEqual([remoteProject]);
    expect(resolveTaskCreateProject({ projects: eligible, context, selection: null })).toBeNull();
    expect(
      taskCreateCommand({
        ...submitInput,
        projects: eligible,
        context,
        selection: { environmentId: local, projectId },
      }),
    ).toBeNull();
  });

  it("requires choice for ambiguous logical groups, ignoring their representative", () => {
    expect(
      resolveTaskCreateContext({
        environmentId: null,
        projectKey: "logical:t3",
        projectScope: scope(projects),
      }),
    ).toEqual({});
  });

  it("uses an explicit physical registration or an unambiguous environment in a group", () => {
    const projectScope = scope(projects);
    expect(
      resolveTaskCreateContext({
        environmentId: null,
        projectKey: scopedProjectKey(remote, projectId),
        projectScope,
      }),
    ).toEqual({ environmentId: remote, projectId });
    expect(
      resolveTaskCreateContext({
        environmentId: remote,
        projectKey: projectScope.key,
        projectScope,
      }),
    ).toEqual({ environmentId: remote, projectId });
  });

  it("does not select a different environment when a route project disappears or loses capability", () => {
    const context = { environmentId: remote, projectId };
    for (const eligible of [
      taskCreateProjects({ projects: [localProject], capableIds, context }),
      taskCreateProjects({ projects, capableIds: new Set([local]), context }),
    ]) {
      expect(eligible).toEqual([]);
      expect(resolveTaskCreateProject({ projects: eligible, context, selection: null })).toBeNull();
      expect(
        taskCreateCommand({ ...submitInput, projects: eligible, context, selection: null }),
      ).toBeNull();
    }
  });

  it("keeps a removed user choice empty instead of restoring the route or first project", () => {
    const context = { environmentId: local, projectId };
    const selection = { environmentId: local, projectId: ProjectId.make("removed") };
    expect(resolveTaskCreateProject({ projects, context, selection })).toBeNull();
    expect(taskCreateCommand({ ...submitInput, projects, context, selection })).toBeNull();
  });

  it("builds the exact scoped create command from a user choice among duplicate project IDs", () => {
    const context = {};
    const eligible = taskCreateProjects({ projects, capableIds, context });
    expect(
      taskCreateCommand({
        ...submitInput,
        projects: eligible,
        context,
        selection: { environmentId: remote, projectId },
      }),
    ).toEqual({
      environmentId: remote,
      input: { taskId, name: "Ship it", description: "Ready", primaryProjectId: projectId },
    });
  });

  it("uses the scoped route target when no choice was made and rejects blank names", () => {
    const input = {
      ...submitInput,
      projects,
      context: { environmentId: local, projectId },
      selection: null,
      description: "  ",
    };
    expect(taskCreateCommand(input)).toEqual({
      environmentId: local,
      input: { taskId, name: "Ship it", description: null, primaryProjectId: projectId },
    });
    expect(taskCreateCommand({ ...input, name: "  " })).toBeNull();
  });
});
