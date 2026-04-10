import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { describe, expect, it } from "vitest";

import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  type AppState,
  type EnvironmentState,
} from "./store";
import { deriveLogicalProjectKey } from "./logicalProject";
import type { Project, SidebarThreadSummary } from "./types";
import { DEFAULT_INTERACTION_MODE } from "./types";

// ── Fixture Identifiers ──────────────────────────────────────────────

const primaryEnvId = EnvironmentId.make("env-primary");
const remoteEnvId = EnvironmentId.make("env-remote");

const sharedProjectPrimaryId = ProjectId.make("shared-proj-primary");
const sharedProjectRemoteId = ProjectId.make("shared-proj-remote");
const localOnlyProjectId = ProjectId.make("local-only-proj");
const remoteOnlyProjectId = ProjectId.make("remote-only-proj");

const threadP1 = ThreadId.make("thread-shared-primary-1");
const threadP2 = ThreadId.make("thread-shared-primary-2");
const threadR1 = ThreadId.make("thread-shared-remote-1");
const threadL1 = ThreadId.make("thread-local-only-1");
const threadRO1 = ThreadId.make("thread-remote-only-1");

const SHARED_REPO_CANONICAL_KEY = "github.com/example/shared-repo";

// ── Factory Helpers ──────────────────────────────────────────────────

function makeProject(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name">,
): Project {
  return {
    cwd: `/tmp/${overrides.name}`,
    defaultModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> &
    Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId" | "title">,
): SidebarThreadSummary {
  return {
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeEmptyEnvironmentState(): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
}

// ── Fixture: Two environments, shared + local-only + remote-only projects ──

function makeFixtureState(): AppState {
  // Shared project: same repo in both envs
  const sharedProjectPrimary = makeProject({
    id: sharedProjectPrimaryId,
    environmentId: primaryEnvId,
    name: "shared-repo",
    repositoryIdentity: {
      canonicalKey: SHARED_REPO_CANONICAL_KEY,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
  });
  const sharedProjectRemote = makeProject({
    id: sharedProjectRemoteId,
    environmentId: remoteEnvId,
    name: "shared-repo",
    repositoryIdentity: {
      canonicalKey: SHARED_REPO_CANONICAL_KEY,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
  });
  // Local-only project
  const localOnlyProject = makeProject({
    id: localOnlyProjectId,
    environmentId: primaryEnvId,
    name: "local-only",
  });
  // Remote-only project
  const remoteOnlyProject = makeProject({
    id: remoteOnlyProjectId,
    environmentId: remoteEnvId,
    name: "remote-only",
  });

  // Threads
  const summaryP1 = makeSidebarThreadSummary({
    id: threadP1,
    environmentId: primaryEnvId,
    projectId: sharedProjectPrimaryId,
    title: "Shared primary thread 1",
  });
  const summaryP2 = makeSidebarThreadSummary({
    id: threadP2,
    environmentId: primaryEnvId,
    projectId: sharedProjectPrimaryId,
    title: "Shared primary thread 2",
  });
  const summaryR1 = makeSidebarThreadSummary({
    id: threadR1,
    environmentId: remoteEnvId,
    projectId: sharedProjectRemoteId,
    title: "Shared remote thread 1",
  });
  const summaryL1 = makeSidebarThreadSummary({
    id: threadL1,
    environmentId: primaryEnvId,
    projectId: localOnlyProjectId,
    title: "Local only thread 1",
  });
  const summaryRO1 = makeSidebarThreadSummary({
    id: threadRO1,
    environmentId: remoteEnvId,
    projectId: remoteOnlyProjectId,
    title: "Remote only thread 1",
  });

  const primaryEnvState: EnvironmentState = {
    ...makeEmptyEnvironmentState(),
    projectIds: [sharedProjectPrimaryId, localOnlyProjectId],
    projectById: {
      [sharedProjectPrimaryId]: sharedProjectPrimary,
      [localOnlyProjectId]: localOnlyProject,
    },
    threadIds: [threadP1, threadP2, threadL1],
    threadIdsByProjectId: {
      [sharedProjectPrimaryId]: [threadP1, threadP2],
      [localOnlyProjectId]: [threadL1],
    },
    sidebarThreadSummaryById: {
      [threadP1]: summaryP1,
      [threadP2]: summaryP2,
      [threadL1]: summaryL1,
    },
  };

  const remoteEnvState: EnvironmentState = {
    ...makeEmptyEnvironmentState(),
    projectIds: [sharedProjectRemoteId, remoteOnlyProjectId],
    projectById: {
      [sharedProjectRemoteId]: sharedProjectRemote,
      [remoteOnlyProjectId]: remoteOnlyProject,
    },
    threadIds: [threadR1, threadRO1],
    threadIdsByProjectId: {
      [sharedProjectRemoteId]: [threadR1],
      [remoteOnlyProjectId]: [threadRO1],
    },
    sidebarThreadSummaryById: {
      [threadR1]: summaryR1,
      [threadRO1]: summaryRO1,
    },
  };

  return {
    activeEnvironmentId: primaryEnvId,
    environmentStateById: {
      [primaryEnvId]: primaryEnvState,
      [remoteEnvId]: remoteEnvState,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("environment grouping", () => {
  describe("deriveLogicalProjectKey", () => {
    it("uses repositoryIdentity.canonicalKey when present", () => {
      const project = makeProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
        repositoryIdentity: {
          canonicalKey: SHARED_REPO_CANONICAL_KEY,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/shared-repo.git",
          },
        },
      });
      expect(deriveLogicalProjectKey(project)).toBe(SHARED_REPO_CANONICAL_KEY);
    });

    it("falls back to scoped project key when no repositoryIdentity", () => {
      const project = makeProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "local-only",
      });
      const key = deriveLogicalProjectKey(project);
      expect(key).toContain(primaryEnvId);
      expect(key).toContain(localOnlyProjectId);
    });

    it("groups projects from different environments that share the same canonical key", () => {
      const primary = makeProject({
        id: sharedProjectPrimaryId,
        environmentId: primaryEnvId,
        name: "shared-repo",
        repositoryIdentity: {
          canonicalKey: SHARED_REPO_CANONICAL_KEY,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/shared-repo.git",
          },
        },
      });
      const remote = makeProject({
        id: sharedProjectRemoteId,
        environmentId: remoteEnvId,
        name: "shared-repo",
        repositoryIdentity: {
          canonicalKey: SHARED_REPO_CANONICAL_KEY,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/example/shared-repo.git",
          },
        },
      });
      expect(deriveLogicalProjectKey(primary)).toBe(deriveLogicalProjectKey(remote));
    });

    it("does NOT group projects without shared canonical key", () => {
      const local = makeProject({
        id: localOnlyProjectId,
        environmentId: primaryEnvId,
        name: "local-only",
      });
      const remote = makeProject({
        id: remoteOnlyProjectId,
        environmentId: remoteEnvId,
        name: "remote-only",
      });
      expect(deriveLogicalProjectKey(local)).not.toBe(deriveLogicalProjectKey(remote));
    });
  });

  describe("selectProjectsAcrossEnvironments", () => {
    it("returns all projects from all environments", () => {
      const state = makeFixtureState();
      const projects = selectProjectsAcrossEnvironments(state);
      expect(projects).toHaveLength(4);
      const names = projects.map((p) => p.name).toSorted();
      expect(names).toEqual(["local-only", "remote-only", "shared-repo", "shared-repo"]);
    });
  });

  describe("selectSidebarThreadsAcrossEnvironments", () => {
    it("returns all sidebar thread summaries from all environments", () => {
      const state = makeFixtureState();
      const threads = selectSidebarThreadsAcrossEnvironments(state);
      expect(threads).toHaveLength(5);
      const ids = new Set(threads.map((t) => t.id));
      expect(ids).toContain(threadP1);
      expect(ids).toContain(threadP2);
      expect(ids).toContain(threadR1);
      expect(ids).toContain(threadL1);
      expect(ids).toContain(threadRO1);
    });
  });

  describe("selectSidebarThreadsForProjectRef", () => {
    it("returns threads for a single project ref", () => {
      const state = makeFixtureState();
      const ref = scopeProjectRef(primaryEnvId, sharedProjectPrimaryId);
      const threads = selectSidebarThreadsForProjectRef(state, ref);
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id)).toEqual([threadP1, threadP2]);
    });

    it("returns empty array for null ref", () => {
      const state = makeFixtureState();
      expect(selectSidebarThreadsForProjectRef(state, null)).toEqual([]);
    });

    it("returns empty array for nonexistent environment", () => {
      const state = makeFixtureState();
      const ref = scopeProjectRef(EnvironmentId.make("nonexistent"), sharedProjectPrimaryId);
      expect(selectSidebarThreadsForProjectRef(state, ref)).toEqual([]);
    });
  });

  describe("selectSidebarThreadsForProjectRefs", () => {
    it("returns empty for empty refs", () => {
      const state = makeFixtureState();
      expect(selectSidebarThreadsForProjectRefs(state, [])).toEqual([]);
    });

    it("returns threads for a single ref", () => {
      const state = makeFixtureState();
      const refs = [scopeProjectRef(primaryEnvId, sharedProjectPrimaryId)];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id)).toEqual([threadP1, threadP2]);
    });

    it("returns combined threads from multiple refs across environments", () => {
      const state = makeFixtureState();
      const refs = [
        scopeProjectRef(primaryEnvId, sharedProjectPrimaryId),
        scopeProjectRef(remoteEnvId, sharedProjectRemoteId),
      ];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(3);
      const ids = new Set(threads.map((t) => t.id));
      expect(ids).toContain(threadP1);
      expect(ids).toContain(threadP2);
      expect(ids).toContain(threadR1);
    });

    it("returns threads from remote-only project", () => {
      const state = makeFixtureState();
      const refs = [scopeProjectRef(remoteEnvId, remoteOnlyProjectId)];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(threadRO1);
    });

    it("returns threads from local-only project", () => {
      const state = makeFixtureState();
      const refs = [scopeProjectRef(primaryEnvId, localOnlyProjectId)];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(threadL1);
    });

    it("handles refs with nonexistent environment gracefully", () => {
      const state = makeFixtureState();
      const refs = [
        scopeProjectRef(primaryEnvId, sharedProjectPrimaryId),
        scopeProjectRef(EnvironmentId.make("nonexistent"), ProjectId.make("nope")),
      ];
      const threads = selectSidebarThreadsForProjectRefs(state, refs);
      // Only returns threads from the valid ref
      expect(threads).toHaveLength(2);
      expect(threads.map((t) => t.id)).toEqual([threadP1, threadP2]);
    });
  });

  describe("logical project grouping for sidebar", () => {
    it("computes correct logical key for grouped projects and aggregates threads", () => {
      const state = makeFixtureState();
      const allProjects = selectProjectsAcrossEnvironments(state);

      // Group by logical key
      const groups = new Map<string, Project[]>();
      for (const project of allProjects) {
        const key = deriveLogicalProjectKey(project);
        const existing = groups.get(key) ?? [];
        existing.push(project);
        groups.set(key, existing);
      }

      // Shared project should be grouped
      const sharedGroup = groups.get(SHARED_REPO_CANONICAL_KEY);
      expect(sharedGroup).toBeDefined();
      expect(sharedGroup).toHaveLength(2);
      expect(sharedGroup!.map((p) => p.environmentId).toSorted()).toEqual(
        [primaryEnvId, remoteEnvId].toSorted(),
      );

      // Build member refs for the grouped project and fetch threads
      const memberRefs = sharedGroup!.map((p) => scopeProjectRef(p.environmentId, p.id));
      const threads = selectSidebarThreadsForProjectRefs(state, memberRefs);
      expect(threads).toHaveLength(3);
      const threadIds = threads.map((t) => t.id);
      expect(threadIds).toContain(threadP1);
      expect(threadIds).toContain(threadP2);
      expect(threadIds).toContain(threadR1);
    });

    it("local-only and remote-only projects remain ungrouped", () => {
      const state = makeFixtureState();
      const allProjects = selectProjectsAcrossEnvironments(state);

      const groups = new Map<string, Project[]>();
      for (const project of allProjects) {
        const key = deriveLogicalProjectKey(project);
        const existing = groups.get(key) ?? [];
        existing.push(project);
        groups.set(key, existing);
      }

      // Should have 3 groups total: shared, local-only, remote-only
      expect(groups.size).toBe(3);

      // Local-only group
      const localKey = deriveLogicalProjectKey(
        allProjects.find((p) => p.id === localOnlyProjectId)!,
      );
      expect(groups.get(localKey)).toHaveLength(1);

      // Remote-only group
      const remoteKey = deriveLogicalProjectKey(
        allProjects.find((p) => p.id === remoteOnlyProjectId)!,
      );
      expect(groups.get(remoteKey)).toHaveLength(1);
    });
  });
});
