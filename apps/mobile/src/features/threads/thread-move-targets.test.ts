import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  moveToProjectMenuEventId,
  parseMoveToProjectMenuEvent,
  resolveThreadMoveTargets,
} from "./thread-move-targets";

function makeProject(
  id: string,
  options: {
    readonly environmentId?: string;
    readonly title?: string;
    readonly pinnedAt?: string | null;
    readonly archivedAt?: string | null;
    readonly isScratch?: true;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(options.environmentId ?? "pc"),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...(options.pinnedAt !== undefined ? { pinnedAt: options.pinnedAt } : {}),
    ...(options.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
    ...(options.isScratch ? { isScratch: true as const } : {}),
  };
}

describe("resolveThreadMoveTargets", () => {
  const thread = { environmentId: "pc", projectId: "scratch" };

  it("lists this environment's real, unarchived projects, pinned first, then by title", () => {
    const targets = resolveThreadMoveTargets(thread, [
      makeProject("scratch", { title: "No project", isScratch: true }),
      makeProject("zeta", { title: "zeta" }),
      makeProject("alpha", { title: "Alpha" }),
      makeProject("pinned", { title: "Pinned", pinnedAt: "2026-11-01T00:00:00.000Z" }),
      makeProject("archived", { title: "Archived", archivedAt: "2026-11-01T00:00:00.000Z" }),
      makeProject("laptop", { title: "Laptop", environmentId: "laptop" }),
    ]);
    expect(targets.map((target) => target.title)).toEqual(["Pinned", "Alpha", "zeta"]);
  });

  it("leaves out the No project folder found by the server's scratch root", () => {
    const targets = resolveThreadMoveTargets(
      thread,
      [
        makeProject("other-scratch", { title: "No project" }),
        makeProject("alpha", { title: "Alpha" }),
      ],
      "/work/other-scratch",
    );
    expect(targets.map((target) => target.title)).toEqual(["Alpha"]);
  });

  it("offers nothing when the environment has no real projects", () => {
    expect(resolveThreadMoveTargets(thread, [makeProject("scratch", { isScratch: true })])).toEqual(
      [],
    );
  });
});

describe("move-to-project menu events", () => {
  it("round-trips a project id and ignores other events", () => {
    expect(parseMoveToProjectMenuEvent(moveToProjectMenuEventId("p:1"))).toBe("p:1");
    expect(parseMoveToProjectMenuEvent("move-to-project:")).toBeNull();
    expect(parseMoveToProjectMenuEvent("move-up")).toBeNull();
  });
});
