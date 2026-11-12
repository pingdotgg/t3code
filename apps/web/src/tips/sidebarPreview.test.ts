import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sidebarPreviewFolders } from "./sidebarPreview";

describe("sidebarPreviewFolders", () => {
  const environmentId = EnvironmentId.make("env-1");
  const project = (id: string) =>
    ({ environmentId, id: ProjectId.make(id), title: id }) as EnvironmentProject;
  const shell = (
    projectId: string,
    title: string,
    updatedAt: string,
    fields: { parent?: string; settledAt?: string } = {},
  ) => ({
    environmentId,
    projectId: ProjectId.make(projectId),
    title,
    updatedAt,
    archivedAt: null,
    deletedAt: null,
    settledAt: fields.settledAt ?? null,
    lineage: {
      parentThreadId: fields.parent === undefined ? null : ThreadId.make(fields.parent),
      relationshipToParent: null,
      rootThreadId: ThreadId.make(title),
    },
  });
  const names = (folders: ReturnType<typeof sidebarPreviewFolders>) =>
    folders.map((folder) => [folder.name, folder.thread.title]);

  it("shows the most recent open thread of the user's two most recent projects", () => {
    const folders = sidebarPreviewFolders(
      [project("web"), project("api"), project("docs")],
      [
        shell("api", "Old", "2026-01-01T00:00:00.000Z"),
        shell("web", "Newest", "2026-01-05T00:00:00.000Z"),
        shell("web", "Child", "2026-01-06T00:00:00.000Z", { parent: "Newest" }),
        shell("web", "Done", "2026-01-07T00:00:00.000Z", { settledAt: "2026-01-07T00:00:00.000Z" }),
        shell("api", "Newer", "2026-01-04T00:00:00.000Z"),
        shell("api", "Oldest", "2025-12-01T00:00:00.000Z"),
        shell("docs", "Third project", "2026-01-02T00:00:00.000Z"),
      ],
      0,
    );
    expect(names(folders)).toEqual([
      ["web", "Newest"],
      ["api", "Newer"],
    ]);
  });

  it("shows sample folders when the user has fewer than two projects with threads", () => {
    const folders = sidebarPreviewFolders(
      [project("web")],
      [shell("web", "Only", "2026-01-05T00:00:00.000Z")],
      Date.parse("2026-01-06T00:00:00.000Z"),
    );
    expect(folders.map((folder) => folder.project)).toEqual([null, null]);
    expect(folders[0]?.thread.updatedAt).toBe("2026-01-05T22:00:00.000Z");
  });
});
