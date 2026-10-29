import {
  EnvironmentId,
  ProjectId,
  type AgentSessionImportResult,
  type AgentSessionProjectCandidate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatOnboardingImportProgress,
  formatOnboardingImportWarning,
  groupOnboardingProjects,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  shouldImportNextBatch,
} from "./projectImport.logic";

const now = Date.parse("2026-08-22T12:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    title: path.split("/").at(-1) ?? path,
    path,
    sources: ["codex"],
    threadCount: 3,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    git: { remoteKey: null, repository: null },
    ...overrides,
  };
}

const github = (repository: string) => ({
  remoteKey: `github.com/${repository.toLowerCase()}`,
  repository,
});

describe("partitionOnboardingProjects", () => {
  it("keeps existing projects available for thread history import", () => {
    const imported = candidate("/projects/current", { alreadyImported: true });
    const available = candidate("/projects/other");

    expect(partitionOnboardingProjects([imported, available], now)).toEqual({
      available: [imported, available],
      recent: [imported, available],
    });
  });

  it("keeps projects older than 30 days out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const older = candidate("/projects/older", {
      lastActiveAt: "2026-07-01T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, older], now)).toEqual({
      available: [recent, older],
      recent: [recent],
    });
  });

  it("keeps non-git folders and thin histories out of the default selection", () => {
    const repo = candidate("/projects/repo");
    const folder = candidate("/projects/folder", { git: null });
    const thin = candidate("/projects/thin", { threadCount: 2 });

    expect(partitionOnboardingProjects([repo, folder, thin], now).recent).toEqual([repo]);
  });

  it("selects candidates from servers that do not report git identity", () => {
    const { git: _git, ...legacy } = candidate("/projects/legacy");

    expect(partitionOnboardingProjects([legacy], now).recent).toEqual([legacy]);
  });
});

describe("groupOnboardingProjects", () => {
  it("groups clones by origin, keeps local repos separate, and folds non-git folders away", () => {
    const main = candidate("/code/t3code", {
      git: github("pingdotgg/t3code"),
      threadCount: 79,
      lastActiveAt: "2026-08-21T12:00:00.000Z",
    });
    const clone = candidate("/code/clones/t3code-2", {
      git: github("pingdotgg/t3code"),
      threadCount: 13,
      lastActiveAt: "2026-08-10T12:00:00.000Z",
    });
    const older = candidate("/code/fleet", {
      git: github("t3dotgg/fleet"),
      threadCount: 295,
      lastActiveAt: "2026-08-22T00:00:00.000Z",
    });
    const local = candidate("/code/scratch-repo", { title: "scratch-repo" });
    const folder = candidate("/tmp/notes", { git: null });

    const grouped = groupOnboardingProjects([main, clone, older, local, folder]);

    expect(grouped.other).toEqual([folder]);
    expect(
      grouped.repositories.map((group) => ({
        label: group.label,
        paths: group.candidates.map((item) => item.path),
        threadCount: group.threadCount,
        lastActiveAt: group.lastActiveAt,
      })),
    ).toEqual([
      {
        label: "t3dotgg/fleet",
        paths: ["/code/fleet"],
        threadCount: 295,
        lastActiveAt: "2026-08-22T00:00:00.000Z",
      },
      {
        label: "pingdotgg/t3code",
        paths: ["/code/t3code", "/code/clones/t3code-2"],
        threadCount: 92,
        lastActiveAt: "2026-08-21T12:00:00.000Z",
      },
      {
        label: "scratch-repo",
        paths: ["/code/scratch-repo"],
        threadCount: 3,
        lastActiveAt: "2026-08-20T12:00:00.000Z",
      },
    ]);
  });

  // regression: #10547 project import broke on servers that predate git identity
  it("lists candidates without git identity as standalone repositories", () => {
    const { git: _git, ...legacy } = candidate("/code/legacy", { title: "legacy" });

    const grouped = groupOnboardingProjects([legacy]);

    expect(grouped.other).toEqual([]);
    expect(grouped.repositories.map((group) => [group.label, group.repository])).toEqual([
      ["legacy", null],
    ]);
  });
});

describe("resolveOnboardingProjectId", () => {
  const localEnvironmentId = EnvironmentId.make("local");
  const remoteEnvironmentId = EnvironmentId.make("remote");
  const localProjectId = ProjectId.make("local-project");

  it("uses the scanned project ID when the client still has an older project at that root", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("stale-project"),
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo", { projectId: localProjectId }),
      ),
    ).toBe(localProjectId);
  });

  it("finds an existing project by normalized root in the target environment", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("remote-project"),
            environmentId: remoteEnvironmentId,
            workspaceRoot: "C:\\Work\\Repo",
          },
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "C:\\Work\\Repo\\",
          },
        ],
        localEnvironmentId,
        candidate("c:/work/repo"),
      ),
    ).toBe(localProjectId);
  });

  it("does not reuse a project from another environment", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("remote-project"),
            environmentId: remoteEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBeNull();
  });
});

describe("resolveOnboardingLandingProject", () => {
  it("prefers a partial first import that added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/partial", "/projects/complete"],
        new Map([["/projects/partial", "partial"]]),
        new Map([["/projects/complete", "complete"]]),
      ),
    ).toBe("partial");
  });

  it("uses a completed zero-history project when no import added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/empty", "/projects/failed"],
        new Map(),
        new Map([["/projects/empty", "empty"]]),
      ),
    ).toBe("empty");
  });

  it("ignores cached successes outside the current retry selection", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/current"],
        new Map([["/projects/previous", "previous"]]),
        new Map([
          ["/projects/previous", "previous"],
          ["/projects/current", "current"],
        ]),
      ),
    ).toBe("current");
  });
});

describe("projects on multiple computers", () => {
  it("keeps identical paths independent when selecting a landing project after partial imports", () => {
    const first = onboardingProjectKey(EnvironmentId.make("first"), "/code/app");
    const second = onboardingProjectKey(EnvironmentId.make("second"), "/code/app");
    const completed = new Map([[first, "first-project"]]);
    expect(completed.has(second)).toBe(false);
    expect(resolveOnboardingLandingProject([second], completed, completed)).toBeUndefined();
    completed.set(second, "second-project");
    expect(resolveOnboardingLandingProject([second, first], completed, completed)).toBe(
      "second-project",
    );
  });

  // regression: #10465 multi-computer onboarding mixed up which computer a project came from
  it("preserves computer identity when choosing recent projects", () => {
    const first = { ...candidate("/code/app"), environmentId: "first" };
    const second = { ...candidate("/code/app"), environmentId: "second" };
    expect(partitionOnboardingProjects([first, second], now).recent).toEqual([first, second]);
  });
});

describe("shouldImportNextBatch", () => {
  const batch = (skippedCount: number, deferredCount?: number): AgentSessionImportResult => ({
    importedCount: 1,
    skippedCount,
    ...(deferredCount === undefined ? {} : { deferredCount }),
  });

  it.each([
    ["old server without deferredCount", batch(5), batch(5), false],
    ["first batch with deferred threads", undefined, batch(5, 5), true],
    ["deferred threads shrinking", batch(5, 5), batch(3, 3), true],
    ["deferred threads unchanged", batch(5, 5), batch(5, 5), false],
    ["nothing deferred", batch(5, 5), batch(2, 0), false],
    ["first batch with nothing deferred", undefined, batch(0, 0), false],
  ] as const)("%s", (_name, previous, current, expected) => {
    expect(shouldImportNextBatch(previous, current)).toBe(expected);
  });
});

describe("formatOnboardingImportProgress", () => {
  const project = { title: "web", position: 2, total: 3 };

  it.each([
    [{ ...project, total: 1, batch: null }, "Importing web…"],
    [{ ...project, batch: null }, "Importing web (2 of 3)…"],
    [
      { ...project, batch: { importedCount: 100, skippedCount: 153, deferredCount: 153 } },
      "Importing web (2 of 3)… 100 threads imported, 153 left",
    ],
    [
      { ...project, batch: { importedCount: 1, skippedCount: 0, deferredCount: 0 } },
      "Importing web (2 of 3)… 1 thread imported",
    ],
    [
      { ...project, batch: { importedCount: 4, skippedCount: 2 } },
      "Importing web (2 of 3)… 4 threads imported",
    ],
  ] as const)("%j", (input, expected) => {
    expect(formatOnboardingImportProgress(input)).toBe(expected);
  });
});

describe("formatOnboardingImportWarning", () => {
  it.each([
    [
      { imported: 3, failed: 2, deferred: 0, stopped: false },
      "Imported 3 threads. 2 threads could not be imported.",
    ],
    [{ imported: 0, failed: 1, deferred: 0, stopped: false }, "1 thread could not be imported."],
    [
      { imported: 1, failed: 0, deferred: 0, stopped: false },
      "Imported 1 thread. Some thread history could not be imported.",
    ],
    [{ imported: 0, failed: 0, deferred: 0, stopped: false }, "Could not import thread history."],
    [
      { imported: 4, failed: 0, deferred: 1, stopped: false },
      "Imported 4 threads. 1 thread was not imported yet.",
    ],
    [
      { imported: 4, failed: 2, deferred: 3, stopped: false },
      "Imported 4 threads. 2 threads could not be imported. 3 threads were not imported yet.",
    ],
    [
      { imported: 4, failed: 0, deferred: 3, stopped: true },
      "Import stopped. Imported 4 threads. 3 threads were not imported yet.",
    ],
    [{ imported: 0, failed: 0, deferred: 0, stopped: true }, "Import stopped."],
  ] as const)("%j", (input, expected) => {
    expect(formatOnboardingImportWarning(input)).toBe(expected);
  });
});
