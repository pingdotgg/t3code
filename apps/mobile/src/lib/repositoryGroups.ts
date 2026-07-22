import * as Order from "effect/Order";
import * as Arr from "effect/Array";
import {
  excludeGeneralChatsProject,
  excludeGeneralChatsThreads,
} from "@t3tools/client-runtime/general-chats";
import type { RepositoryIdentity } from "@t3tools/contracts";

import { scopedProjectKey } from "./scopedEntities";
import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

const DateDescending = Order.flip(Order.Date);

export interface RepositoryProjectGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly latestActivityAt: string;
}

export interface RepositoryGroup {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly latestActivityAt: string;
  readonly projects: ReadonlyArray<RepositoryProjectGroup>;
}

function compareIsoDateDescending(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

function deriveRepositoryGroupKey(project: EnvironmentProject): string {
  return (
    project.repositoryIdentity?.canonicalKey ?? scopedProjectKey(project.environmentId, project.id)
  );
}

function deriveRepositoryTitle(project: EnvironmentProject): string {
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
  project: EnvironmentProject,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): string {
  const latestThread = threads[0];
  return latestThread?.updatedAt ?? latestThread?.createdAt ?? project.updatedAt;
}

export function groupProjectsByRepository(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<RepositoryGroup> {
  const projects = excludeGeneralChatsProject(input.projects);
  const threads = excludeGeneralChatsThreads(input.threads);
  const threadsByProjectKey = new Map<string, EnvironmentThreadShell[]>();

  for (const thread of threads) {
    const key = scopedProjectKey(thread.environmentId, thread.projectId);
    const existing = threadsByProjectKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(key, [thread]);
    }
  }

  const grouped = new Map<string, RepositoryGroup>();

  for (const project of projects) {
    const key = deriveRepositoryGroupKey(project);
    const projectKey = scopedProjectKey(project.environmentId, project.id);
    const threads = Arr.sortWith(
      threadsByProjectKey.get(projectKey) ?? [],
      (s) => new Date(s.updatedAt ?? s.createdAt),
      DateDescending,
    );

    const latestActivityAt = deriveProjectLatestActivity(project, threads);
    const projectGroup: RepositoryProjectGroup = {
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
        DateDescending,
      ),
    });
  }

  return Arr.sortWith(grouped.values(), (s) => new Date(s.latestActivityAt), DateDescending);
}
