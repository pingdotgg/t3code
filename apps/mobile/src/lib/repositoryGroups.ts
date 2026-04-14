import * as Order from "effect/Order";
import * as Arr from "effect/Array";
import type { RepositoryIdentity } from "@t3tools/contracts";

import { scopedProjectKey } from "./scopedEntities";
import {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
} from "@t3tools/client-runtime";

export interface MobileRepositoryProjectGroup {
  readonly key: string;
  readonly project: EnvironmentScopedProjectShell;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
  readonly latestActivityAt: string;
}

export interface MobileRepositoryGroup {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly latestActivityAt: string;
  readonly projects: ReadonlyArray<MobileRepositoryProjectGroup>;
}

function compareIsoDateDescending(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

function deriveRepositoryGroupKey(project: EnvironmentScopedProjectShell): string {
  return (
    project.repositoryIdentity?.canonicalKey ?? scopedProjectKey(project.environmentId, project.id)
  );
}

function deriveRepositoryTitle(project: EnvironmentScopedProjectShell): string {
  const identity = project.repositoryIdentity;
  return identity?.displayName ?? identity?.name ?? project.title;
}

function deriveRepositorySubtitle(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) {
    return null;
  }
  if (identity.owner && identity.name) {
    return `${identity.owner}/${identity.name}`;
  }
  return identity.canonicalKey;
}

function deriveProjectLatestActivity(
  project: EnvironmentScopedProjectShell,
  threads: ReadonlyArray<EnvironmentScopedThreadShell>,
): string {
  const latestThread = threads[0];
  return latestThread?.updatedAt ?? latestThread?.createdAt ?? project.updatedAt;
}

export function groupProjectsByRepository(input: {
  readonly projects: ReadonlyArray<EnvironmentScopedProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
}): ReadonlyArray<MobileRepositoryGroup> {
  const threadsByProjectKey = new Map<string, EnvironmentScopedThreadShell[]>();

  for (const thread of input.threads) {
    const key = scopedProjectKey(thread.environmentId, thread.projectId);
    const existing = threadsByProjectKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(key, [thread]);
    }
  }

  const grouped = new Map<string, MobileRepositoryGroup>();

  for (const project of input.projects) {
    const key = deriveRepositoryGroupKey(project);
    const projectKey = scopedProjectKey(project.environmentId, project.id);
    const threads = Arr.sortWith(
      threadsByProjectKey.get(projectKey) ?? [],
      (s) => new Date(s.updatedAt ?? s.createdAt),
      Order.Date,
    );

    const latestActivityAt = deriveProjectLatestActivity(project, threads);
    const projectGroup: MobileRepositoryProjectGroup = {
      key: projectKey,
      project,
      threads,
      latestActivityAt,
    };

    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        title: deriveRepositoryTitle(project),
        subtitle: deriveRepositorySubtitle(project.repositoryIdentity),
        repositoryIdentity: project.repositoryIdentity ?? null,
        projectCount: 1,
        threadCount: threads.length,
        latestActivityAt,
        projects: [projectGroup],
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      title: existing.repositoryIdentity ? existing.title : deriveRepositoryTitle(project),
      subtitle: existing.subtitle ?? deriveRepositorySubtitle(project.repositoryIdentity),
      repositoryIdentity: existing.repositoryIdentity ?? project.repositoryIdentity ?? null,
      projectCount: existing.projectCount + 1,
      threadCount: existing.threadCount + threads.length,
      latestActivityAt:
        compareIsoDateDescending(existing.latestActivityAt, latestActivityAt) > 0
          ? latestActivityAt
          : existing.latestActivityAt,
      projects: Arr.sortWith(
        [...existing.projects, projectGroup],
        (s) => new Date(s.latestActivityAt),
        Order.Date,
      ),
    });
  }

  return Arr.sortWith([...grouped.values()], (s) => new Date(s.latestActivityAt), Order.Date);
}
