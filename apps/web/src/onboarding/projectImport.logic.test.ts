import { EnvironmentId, ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  partitionOnboardingProjects,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
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
    threadCount: 1,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    ...overrides,
  };
}

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
