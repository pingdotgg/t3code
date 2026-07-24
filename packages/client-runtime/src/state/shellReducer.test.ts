import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent, mergeShellSnapshotProjects } from "./shellReducer.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/example/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/repo.git",
  },
};

const otherIdentity = {
  canonicalKey: "github.com/example/other",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/other.git",
  },
};

describe("applyShellStreamEvent", () => {
  it("ignores stale project updates without mutating the snapshot", () => {
    const snapshotWithProject = {
      ...v2ShellSnapshot,
      snapshotSequence: 4,
      projects: [v2Project],
    };

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(snapshotWithProject, {
        kind: "project.updated",
        sequence,
        project: { ...v2Project, title: "Stale Title" },
      });

      expect(next).toBe(snapshotWithProject);
      expect(next.snapshotSequence).toBe(4);
      expect(next.projects[0]?.title).toBe(v2Project.title);
    }
  });

  it("applies project updates and removals", () => {
    const updated = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, title: "Updated" },
    });
    expect(updated.projects[0]?.title).toBe("Updated");
    expect(updated.snapshotSequence).toBe(1);

    const removed = applyShellStreamEvent(updated, {
      kind: "project.removed",
      sequence: 2,
      projectId: ProjectId.make(v2Project.id),
    });
    expect(removed.projects).toEqual([]);
  });

  it("keeps prior repositoryIdentity when a delta arrives with null identity", () => {
    const withIdentity = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, repositoryIdentity },
    });
    expect(withIdentity.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);

    const withoutIdentity = applyShellStreamEvent(withIdentity, {
      kind: "project.updated",
      sequence: 2,
      project: { ...v2Project, title: "Still same root", repositoryIdentity: null },
    });
    expect(withoutIdentity.projects[0]?.title).toBe("Still same root");
    expect(withoutIdentity.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("does not keep prior repositoryIdentity after a workspace root move", () => {
    const withIdentity = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "project.updated",
      sequence: 1,
      project: { ...v2Project, repositoryIdentity },
    });

    const moved = applyShellStreamEvent(withIdentity, {
      kind: "project.updated",
      sequence: 2,
      project: {
        ...v2Project,
        workspaceRoot: "/tmp/other-root",
        repositoryIdentity: null,
      },
    });
    expect(moved.projects[0]?.workspaceRoot).toBe("/tmp/other-root");
    expect(moved.projects[0]?.repositoryIdentity).toBeNull();
  });

  it("merges full snapshot projects without dropping known repositoryIdentity", () => {
    const previous = {
      ...v2ShellSnapshot,
      projects: [{ ...v2Project, repositoryIdentity }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 2,
      projects: [{ ...v2Project, title: "Refreshed", repositoryIdentity: null }],
    });
    expect(next.projects[0]?.title).toBe("Refreshed");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("authoritative lower-sequence reset replaces client-ahead structural state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const next = mergeShellSnapshotProjects(previous, {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    });

    expect(next.snapshotSequence).toBe(3);
    expect(next.projects[0]?.title).toBe("Server reset");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.threads[0]?.title).toBe("Server thread");
  });

  it("client-ahead survives lower marked enrichment then still resets on unmarked authoritative", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 20,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const serverSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    };

    // Lower-sequence marked enrichment is identity-only and must not replace structure.
    const afterEnrichment = mergeShellSnapshotProjects(previous, serverSnapshot, {
      resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot],
    });
    expect(afterEnrichment.snapshotSequence).toBe(20);
    expect(afterEnrichment.projects[0]?.title).toBe("Client ahead");
    expect(afterEnrichment.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterEnrichment.threads[0]?.title).toBe("Local-only thread");

    // Unmarked authoritative at the same lower sequence still performs the reset.
    const afterAuthoritative = mergeShellSnapshotProjects(afterEnrichment, serverSnapshot);
    expect(afterAuthoritative.snapshotSequence).toBe(3);
    expect(afterAuthoritative.projects[0]?.title).toBe("Server reset");
    expect(afterAuthoritative.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterAuthoritative.threads[0]?.title).toBe("Server thread");
  });

  it("authoritative null retains identity then same-sequence marked enrichment clears it", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [{ ...v2Project, title: "Client ahead", repositoryIdentity }],
      threads: [{ ...v2ThreadShell, title: "Local-only thread" }],
    };
    const serverSnapshot = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, title: "Server reset", repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Server thread" }],
    };

    const afterAuthoritative = mergeShellSnapshotProjects(previous, serverSnapshot);
    expect(afterAuthoritative.snapshotSequence).toBe(3);
    expect(afterAuthoritative.projects[0]?.title).toBe("Server reset");
    expect(afterAuthoritative.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(afterAuthoritative.threads[0]?.title).toBe("Server thread");

    const afterEnrichment = mergeShellSnapshotProjects(afterAuthoritative, serverSnapshot, {
      resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot],
    });
    expect(afterEnrichment.snapshotSequence).toBe(3);
    expect(afterEnrichment.projects[0]?.title).toBe("Server reset");
    expect(afterEnrichment.projects[0]?.repositoryIdentity).toBeNull();
    expect(afterEnrichment.threads[0]?.title).toBe("Server thread");
  });

  it("takes identity from a lower-sequence enrichment without reverting live thread state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity: null }],
      threads: [{ ...v2ThreadShell, title: "Newest title" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [{ ...v2ThreadShell, title: "Stale title" }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.threads[0]?.title).toBe("Newest title");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
  });

  it("lower-sequence enrichment cannot resurrect empty structural state", () => {
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 7,
      projects: [],
      threads: [],
      archivedThreads: [],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity }],
        threads: [v2ThreadShell],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.projects).toEqual([]);
    expect(next.threads).toEqual([]);
  });

  it("resolved null clears identity only for the marked root", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 5,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [
          { ...v2Project, repositoryIdentity: null },
          { ...otherProject, repositoryIdentity: null },
        ],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.projects).toHaveLength(2);
    expect(next.projects[0]?.repositoryIdentity).toBeNull();
    expect(next.projects[1]?.repositoryIdentity).toEqual(otherIdentity);
  });

  it("unrelated unresolved roots retain identity in the same enrichment snapshot", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
      threads: [{ ...v2ThreadShell, title: "Current thread" }],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
        projects: [
          { ...v2Project, repositoryIdentity },
          { ...otherProject, repositoryIdentity: null },
        ],
        threads: [{ ...v2ThreadShell, title: "Stale thread" }],
      },
      { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
    );

    expect(next.threads[0]?.title).toBe("Current thread");
    expect(next.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    expect(next.projects[1]?.repositoryIdentity).toEqual(otherIdentity);
  });

  it("clears identity for multiple roots resolved in one enrichment batch", () => {
    const otherProject = {
      ...v2Project,
      id: ProjectId.make("project-other"),
      workspaceRoot: "/workspace/other",
      repositoryIdentity: otherIdentity,
    };
    const previous = {
      ...v2ShellSnapshot,
      snapshotSequence: 3,
      projects: [{ ...v2Project, repositoryIdentity }, otherProject],
    };
    const next = mergeShellSnapshotProjects(
      previous,
      {
        ...v2ShellSnapshot,
        snapshotSequence: 3,
        projects: [
          { ...v2Project, repositoryIdentity: null },
          { ...otherProject, repositoryIdentity: null },
        ],
      },
      {
        resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot, otherProject.workspaceRoot],
      },
    );

    expect(next.projects.map((project) => project.repositoryIdentity)).toEqual([null, null]);
  });

  it("does not replace a live identity with one from an unmarked lower-sequence enrichment", () => {
    const liveIdentity = {
      canonicalKey: "github.com/example/live",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/live.git",
      },
    };
    const staleIdentity = {
      canonicalKey: "github.com/example/stale",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/stale.git",
      },
    };
    const next = mergeShellSnapshotProjects(
      {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        projects: [{ ...v2Project, repositoryIdentity: liveIdentity }],
      },
      {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, repositoryIdentity: staleIdentity }],
      },
      { resolvedRepositoryIdentityRoots: [] },
    );

    expect(next.snapshotSequence).toBe(5);
    expect(next.projects[0]?.repositoryIdentity).toEqual(liveIdentity);
  });

  it("moves a thread between active and archive without duplicating it", () => {
    const archived = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.updated",
      sequence: 3,
      location: "archive",
      thread: { ...v2ThreadShell, archivedAt: v2ThreadShell.updatedAt },
    });
    expect(archived.threads).toEqual([]);
    expect(archived.archivedThreads).toHaveLength(1);

    const active = applyShellStreamEvent(archived, {
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: v2ThreadShell,
    });
    expect(active.threads).toHaveLength(1);
    expect(active.archivedThreads).toEqual([]);
  });

  it("removes a thread from either collection", () => {
    const next = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "thread.removed",
      sequence: 5,
      location: "active",
      threadId: ThreadId.make(v2ThreadShell.id),
    });
    expect(next.threads).toEqual([]);
    expect(next.snapshotSequence).toBe(5);
  });

  it("leaves unknown future events unchanged", () => {
    const next = applyShellStreamEvent(v2ShellSnapshot, {
      kind: "future.event",
      sequence: 99,
    } as never);

    expect(next).toBe(v2ShellSnapshot);
  });
});
