import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentApi,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import type { DraftThreadEnvMode } from "../composerDraftStore";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  normalizeProjectPathForComparison,
} from "./projectPaths";
import { getLatestThreadForProject } from "./threadSort";
import { newCommandId, newProjectId } from "./utils";

interface ProjectLike {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

interface ThreadLike {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly latestUserMessageAt?: string | null;
}

type NavigateFn = (options: {
  to: "/$environmentId/$threadId";
  params: { environmentId: EnvironmentId; threadId: ThreadId };
}) => Promise<unknown> | unknown;

export interface OpenProjectByPathInput {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly api: Pick<EnvironmentApi, "orchestration">;
  readonly projects: ReadonlyArray<ProjectLike>;
  readonly threads: ReadonlyArray<ThreadLike>;
  readonly sidebarThreadSortOrder: SidebarThreadSortOrder;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly navigate: NavigateFn;
  readonly handleNewThread: (
    ref: ScopedProjectRef,
    options: { envMode: DraftThreadEnvMode },
  ) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

// Singleflight per-environment-per-normalized-path. Two rapid events targeting
// the same folder — e.g. `second-instance` + `open-file` firing in quick
// succession — must coalesce into one `project.create` and one navigation.
// The server's `requireProjectAbsent` guards on projectId, not workspaceRoot,
// so without this two fresh UUIDs would both land as distinct projections.
//
// `onErrors` is shared across all callers joining the same in-flight operation
// so every caller's error callback fires on failure — not just the first one.
interface InFlightEntry {
  readonly promise: Promise<void>;
  readonly onErrors: Array<(error: unknown) => void>;
}

const inFlight = new Map<string, InFlightEntry>();

export async function openProjectByPath(input: OpenProjectByPathInput): Promise<void> {
  const key = `${input.environmentId}|${normalizeProjectPathForComparison(input.path)}`;
  const existing = inFlight.get(key);
  if (existing) {
    if (input.onError) existing.onErrors.push(input.onError);
    return existing.promise;
  }

  const onErrors: Array<(error: unknown) => void> = input.onError ? [input.onError] : [];
  const promise = runOpenProjectByPath({
    ...input,
    onError: (error) => {
      for (const fn of onErrors) {
        try {
          fn(error);
        } catch {
          // One bad callback must not prevent the others from firing.
        }
      }
    },
  }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, { promise, onErrors });
  return promise;
}

async function runOpenProjectByPath(input: OpenProjectByPathInput): Promise<void> {
  try {
    const existingProject = findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    );

    if (existingProject) {
      const latestThread = getLatestThreadForProject(
        input.threads.filter((thread) => thread.environmentId === existingProject.environmentId),
        existingProject.id,
        input.sidebarThreadSortOrder,
      );
      if (latestThread) {
        await input.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }
      await input.handleNewThread(
        scopeProjectRef(existingProject.environmentId, existingProject.id),
        { envMode: input.defaultThreadEnvMode },
      );
      return;
    }

    const projectId = newProjectId();
    await input.api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      title: inferProjectTitleFromPath(input.path),
      workspaceRoot: input.path,
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
      createdAt: new Date().toISOString(),
    });
    await input.handleNewThread(scopeProjectRef(input.environmentId, projectId), {
      envMode: input.defaultThreadEnvMode,
    });
  } catch (error) {
    input.onError?.(error);
  }
}

// Exposed only for tests to reset singleflight state between cases.
export function __resetOpenProjectByPathInFlight(): void {
  inFlight.clear();
}
