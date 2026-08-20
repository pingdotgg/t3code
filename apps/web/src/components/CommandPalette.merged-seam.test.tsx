import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { Project, Thread } from "../types";
import {
  buildLocationAwareProjectActionItems,
  buildVisibleThreadActionItems,
} from "./CommandPalette.thread-project-items";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-local");

function makeThread(id: string, title: string): Thread {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-08-18T12:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-08-18T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
  };
}

describe("CommandPalette merged archive and project-location seam", () => {
  it("hides optimistic archives while retaining location description and search metadata", () => {
    const visibleThread = makeThread("thread-visible", "Visible thread");
    const optimisticArchive = makeThread("thread-optimistic", "Optimistically archived thread");
    const threadItems = buildVisibleThreadActionItems({
      threads: [visibleThread, optimisticArchive],
      optimisticallyArchivedThreadKeys: new Set([
        scopedThreadKey(scopeThreadRef(optimisticArchive.environmentId, optimisticArchive.id)),
      ]),
      projectTitleById: new Map([[projectId, "Local project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });

    const project: Project = {
      id: projectId,
      environmentId,
      title: "Local project",
      workspaceRoot: "E:\\Projects\\local-project",
      repositoryIdentity: null,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      },
      createdAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T12:00:00.000Z",
      scripts: [],
    };
    const location = { kind: "local", label: "Local" } as const;
    const [projectItem] = buildLocationAwareProjectActionItems({
      projects: [project],
      valuePrefix: "new-thread-in",
      icon: () => null,
      getLocation: () => location,
      runProject: async () => undefined,
    });

    expect(threadItems.map((item) => item.title)).toEqual(["Visible thread"]);
    expect(projectItem?.searchTerms).toEqual([
      "Local project",
      "E:\\Projects\\local-project",
      "Local",
    ]);
    const descriptionMarkup = renderToStaticMarkup(projectItem?.description);
    expect(descriptionMarkup).toContain(">Local</span>");
    expect(descriptionMarkup).toContain(">·</span>");
    expect(descriptionMarkup).toContain(">E:\\Projects\\local-project</span>");
  });

  it("keeps the rendered remote fallback searchable", () => {
    const project: Project = {
      id: projectId,
      environmentId,
      title: "Remote project",
      workspaceRoot: "/workspace/remote-project",
      repositoryIdentity: null,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      },
      createdAt: "2026-08-18T12:00:00.000Z",
      updatedAt: "2026-08-18T12:00:00.000Z",
      scripts: [],
    };
    const [projectItem] = buildLocationAwareProjectActionItems({
      projects: [project],
      valuePrefix: "new-thread-in",
      icon: () => null,
      getLocation: () => undefined,
      runProject: async () => undefined,
    });

    expect(projectItem?.searchTerms).toEqual([
      "Remote project",
      "/workspace/remote-project",
      "Remote",
    ]);
    expect(renderToStaticMarkup(projectItem?.description)).toContain(">Remote</span>");
  });
});
