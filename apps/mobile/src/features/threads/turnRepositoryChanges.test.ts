import { CheckpointScopeId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { turnHasChanges } from "../../lib/threadActivity";
import {
  groupTurnChangesByRepository,
  outsideEditLabel,
  turnRepositorySectionId,
} from "./turnRepositoryChanges";

const file = (path: string, additions: number, deletions = 0) => ({
  path,
  kind: "modified",
  additions,
  deletions,
});

const repository = (name: string, kind: "home" | "repository" = "repository") => ({
  name,
  kind,
  originalPath: `/code/${name}`,
});

function checkpoint(
  name: string,
  status: "ready" | "missing" | "error" | "stale",
  files: ReadonlyArray<ReturnType<typeof file>>,
) {
  return {
    scopeId: CheckpointScopeId.make(`scope:${name}`),
    name,
    repositoryPath: `/code/${name}`,
    // A task folder thread: repos run in worktrees, not their tracked paths.
    cwd: `/tasks/fix/${name}`,
    status,
    files,
  };
}

const infraEdit = {
  root: "/Users/maria/code/infra",
  name: "infra",
  tracked: false,
  files: ["main.tf", "vars.tf", "outputs.tf"],
  fileCount: 3,
};

describe("turn changes by repository", () => {
  it("lists changed repos home first and folds the rest into dim lines", () => {
    const changes = groupTurnChangesByRepository(
      {
        files: [file("src/app.ts", 10, 2)],
        repositories: [
          checkpoint("api", "ready", []),
          checkpoint("web", "ready", [file("index.ts", 4), file("theme.ts", 1, 1)]),
          checkpoint("broken", "error", []),
        ],
      },
      [
        repository("app", "home"),
        repository("api"),
        repository("web"),
        repository("docs"),
        repository("broken"),
      ],
      "Home",
    );

    expect(changes.multiRepo).toBe(true);
    expect(changes.changed).toEqual([
      { cwd: null, name: "app", fileCount: 1, additions: 10, deletions: 2 },
      { cwd: "/tasks/fix/web", name: "web", fileCount: 2, additions: 5, deletions: 1 },
    ]);
    expect(changes.unchanged).toEqual(["api", "docs"]);
    expect(changes.failed).toEqual(["broken"]);
    expect([changes.additions, changes.deletions]).toEqual([15, 3]);
    expect(turnRepositorySectionId({ checkpointTurnCount: 4 }, changes.changed[0])).toBe("turn:4");
    expect(turnRepositorySectionId({ checkpointTurnCount: 4 }, changes.changed[1])).toBe(
      "repo:/tasks/fix/web|turn:4",
    );
  });

  it("counts only tracked repos when the home folder has no Git history", () => {
    const summary = {
      status: "missing" as const,
      files: [],
      repositories: [checkpoint("web", "ready", [file("index.ts", 4)])],
      outsideEdits: [],
    };
    const changes = groupTurnChangesByRepository(summary, [repository("web")], "Home");
    expect(changes.changed.map((change) => change.name)).toEqual(["web"]);
    expect(changes.unchanged).toEqual([]);
    expect(turnHasChanges(summary)).toBe(true);
  });

  it("keeps single-repo turns on the plain diff stat, even with outside edits", () => {
    const summary = { status: "ready" as const, files: [], repositories: [], outsideEdits: [] };
    expect(groupTurnChangesByRepository(summary, null, "Home").multiRepo).toBe(false);
    expect(turnHasChanges(summary)).toBe(false);
    expect(turnHasChanges({ ...summary, outsideEdits: [infraEdit] })).toBe(true);
  });

  it("names the folder of an outside edit and whether the project tracks it", () => {
    expect(outsideEditLabel(infraEdit)).toBe(
      "Edited 3 files in ~/code/infra, which this project does not track",
    );
    expect(
      outsideEditLabel({ ...infraEdit, root: "/srv/tools", tracked: true, fileCount: 1 }),
    ).toBe("Edited 1 file in /srv/tools, which has no history in this thread");
    expect(outsideEditLabel({ ...infraEdit, root: "C:\\Users\\maria\\infra" })).toBe(
      "Edited 3 files in ~\\infra, which this project does not track",
    );
  });
});
