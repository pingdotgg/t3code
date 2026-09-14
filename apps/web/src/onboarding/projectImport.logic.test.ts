import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupOnboardingProjects,
  onboardingHistorySessionKey,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  selectedOnboardingHistorySessions,
  summarizeOnboardingHistoryImport,
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
  it("keeps existing projects available for setup and optional history review", () => {
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

  it("keeps future activity out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const future = candidate("/projects/future", {
      lastActiveAt: "2026-08-23T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, future], now)).toEqual({
      available: [recent, future],
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

  it("uses the scanned project ID before the project reaches the client", () => {
    expect(
      resolveOnboardingProjectId(
        [],
        localEnvironmentId,
        candidate("/projects/repo", { projectId: localProjectId }),
      ),
    ).toBe(localProjectId);
  });

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

  it("returns null to create a project when neither the scan nor the client has a project ID", () => {
    expect(
      resolveOnboardingProjectId([], localEnvironmentId, candidate("/projects/new")),
    ).toBeNull();
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

  it("finds an alias after the scanner returns its persisted project root", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/real/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/real/projects/repo"),
      ),
    ).toBe(localProjectId);
  });

  it("finds the current root owner when the scan has no project ID", () => {
    const recreatedProjectId = ProjectId.make("recreated-project");
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/other",
          },
          {
            id: recreatedProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBe(recreatedProjectId);
  });

  it("does not reuse a moved project when the scan has no project ID", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/moved",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBeNull();
  });
});

describe("resolveOnboardingLandingProject", () => {
  it("skips a failed first project for a later project with imported history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/failed", "/projects/imported"],
        new Map([["/projects/imported", "imported"]]),
        new Map([["/projects/imported", "imported"]]),
      ),
    ).toBe("imported");
  });

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

  it("keeps an earlier successful import available on retry", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/imported", "/projects/retry"],
        new Map([["/projects/imported", "imported"]]),
        new Map([["/projects/imported", "imported"]]),
      ),
    ).toBe("imported");
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

  it("preserves computer identity when choosing recent projects", () => {
    const first = { ...candidate("/code/app"), environmentId: "first" };
    const second = { ...candidate("/code/app"), environmentId: "second" };
    expect(partitionOnboardingProjects([first, second], now).recent).toEqual([first, second]);
  });
});

describe("reviewed conversation selection", () => {
  const projectKey = onboardingProjectKey(EnvironmentId.make("first"), "/code/app");
  const first = {
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session-1",
    revision: "revision-1",
  };
  const second = {
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerSessionId: "session-2",
    revision: "revision-2",
  };

  it("sends only the exact individually selected transcript revisions", () => {
    const selected = new Set([onboardingHistorySessionKey(projectKey, second)]);

    expect(selectedOnboardingHistorySessions(projectKey, [first, second], selected)).toEqual([
      second,
    ]);
    expect(selectedOnboardingHistorySessions(projectKey, [first, second], new Set())).toEqual([]);
  });
});

describe("conversation import accounting", () => {
  it("does not treat already-imported or excluded sessions as failures", () => {
    expect(
      summarizeOnboardingHistoryImport({
        importedCount: 2,
        skippedCount: 0,
        alreadyImportedCount: 3,
        excludedCount: 4,
        failedCount: 0,
        deferredCount: 0,
      }),
    ).toEqual({ importedCount: 2, failedCount: 0, deferredCount: 0, incompleteCount: 0 });
  });

  it("keeps failed and deferred selections visible as incomplete work", () => {
    expect(
      summarizeOnboardingHistoryImport({
        importedCount: 1,
        skippedCount: 3,
        failedCount: 2,
        deferredCount: 1,
      }),
    ).toEqual({ importedCount: 1, failedCount: 2, deferredCount: 1, incompleteCount: 3 });
  });

  it("understands legacy skipped-count results", () => {
    expect(summarizeOnboardingHistoryImport({ importedCount: 1, skippedCount: 2 })).toEqual({
      importedCount: 1,
      failedCount: 2,
      deferredCount: 0,
      incompleteCount: 2,
    });
  });
});
