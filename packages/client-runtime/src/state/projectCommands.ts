import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  refreshQueryOnSuccess,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  const readFileQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:projects:read-file-query",
    tag: WS_METHODS.projectsReadFile,
    // Workspace files can change outside T3 Code, so always revalidate cached reads on mount.
    staleTimeMs: 0,
    idleTtlMs: 5 * 60_000,
  });
  const fileChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:projects:file-changes",
    tag: WS_METHODS.projectsWatchFile,
    idleTtlMs: 0,
  });
  type ReadFileAtom = ReturnType<typeof readFileQuery>;
  const liveReadFileAtoms = new WeakMap<ReadFileAtom, ReadFileAtom>();
  const readFile = (target: Parameters<typeof readFileQuery>[0]): ReadFileAtom => {
    const queryAtom = readFileQuery(target);
    const cached = liveReadFileAtoms.get(queryAtom);
    if (cached) return cached;

    const changesAtom = fileChanges(target);
    const liveAtom = refreshQueryOnSuccess(queryAtom, changesAtom).pipe(
      Atom.withLabel(`environment-data:projects:read-file:${target.input.relativePath}`),
    );
    liveReadFileAtoms.set(queryAtom, liveAtom);
    return liveAtom;
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile,
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
  };
}
