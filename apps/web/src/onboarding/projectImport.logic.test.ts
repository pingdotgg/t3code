import { EnvironmentId, ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionOnboardingProjects, resolveOnboardingProjectId } from "./projectImport.logic";

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
        "c:/work/repo",
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
        "/projects/repo",
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
        "/real/projects/repo",
      ),
    ).toBe(localProjectId);
  });

  it("prefers the current root owner over a stale scanner hint", () => {
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
        "/projects/repo",
      ),
    ).toBe(recreatedProjectId);
  });

  it("does not reuse a project after its root changed since the scan", () => {
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
        "/projects/repo",
      ),
    ).toBeNull();
  });
});
