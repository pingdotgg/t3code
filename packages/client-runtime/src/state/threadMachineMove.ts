import type {
  EnvironmentId,
  ProjectExportThreadResult,
  ProjectFinishThreadMoveInput,
  ProjectId,
  ProjectImportThreadInput,
  ProjectImportThreadResult,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { scopedThreadKey } from "../environment/scoped.ts";
import { type EnvironmentProject, threadMoveProjects } from "./models.ts";
import {
  type AtomCommand,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";

type EnvironmentCommand<I, A> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: I },
  A,
  unknown
>;

export interface ThreadMachineMoveCommands {
  readonly exportThread: EnvironmentCommand<
    { readonly threadId: ThreadId },
    ProjectExportThreadResult
  >;
  readonly importThread: EnvironmentCommand<ProjectImportThreadInput, ProjectImportThreadResult>;
  readonly finishThreadMove: EnvironmentCommand<ProjectFinishThreadMoveInput, void>;
}

export type ThreadMachineMoveOutcome =
  | { readonly _tag: "Cancelled" }
  /** Nothing changed on either machine. */
  | { readonly _tag: "Failed"; readonly message: string }
  /** The new thread exists; `archiveError` says the old one is still active beside it. */
  | {
      readonly _tag: "Moved";
      readonly threadRef: ScopedThreadRef;
      readonly archiveError: string | null;
    };

export interface ThreadMachineMoveTarget<P = EnvironmentProject> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projects: ReadonlyArray<P>;
}

interface MoveServerConfig {
  readonly scratchWorkspaceRoot?: string | undefined;
  readonly environment: { readonly capabilities: { readonly threadMoveToMachine?: boolean } };
}

/**
 * The other connected machines a thread can move to, each with its projects. Both ends must
 * support it, and this connection must be able to change threads on both.
 */
export function threadMachineMoveTargets<
  P extends Parameters<typeof threadMoveProjects>[0][number],
>(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, MoveServerConfig>;
  readonly projects: ReadonlyArray<P>;
  readonly labelOf: (environmentId: EnvironmentId) => string | undefined;
  readonly canOperate: (environmentId: EnvironmentId) => boolean;
}): ReadonlyArray<ThreadMachineMoveTarget<P>> {
  const supports = (environmentId: EnvironmentId) =>
    input.serverConfigs.get(environmentId)?.environment.capabilities.threadMoveToMachine === true;
  if (!supports(input.sourceEnvironmentId) || !input.canOperate(input.sourceEnvironmentId)) {
    return [];
  }
  return input.connectedEnvironmentIds.flatMap((environmentId) => {
    const label = input.labelOf(environmentId);
    if (
      environmentId === input.sourceEnvironmentId ||
      label === undefined ||
      !supports(environmentId) ||
      !input.canOperate(environmentId)
    ) {
      return [];
    }
    const projects = threadMoveProjects(
      input.projects,
      environmentId,
      input.serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
    );
    return projects.length === 0 ? [] : [{ environmentId, label, projects }];
  });
}

function failureMessage(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "Try again.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message !== "" ? error.message : "Try again.";
}

const movesInFlight = new Set<string>();

/**
 * Copies the thread's conversation to a project on another machine, then archives it here. The
 * client carries the bundle over connections it already has, so the servers never trust each
 * other. Archiving waits for the import, so a failed import changes nothing.
 */
export async function moveThreadToMachine(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly commands: ThreadMachineMoveCommands;
  readonly source: ScopedThreadRef;
  readonly sourceLabel: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  /** "api on VPS": where the archived thread says it went. */
  readonly targetLabel: string;
  readonly confirm: (exported: ProjectExportThreadResult) => Promise<boolean>;
}): Promise<ThreadMachineMoveOutcome> {
  // A second pick while one runs would import the conversation twice.
  const key = scopedThreadKey(input.source);
  if (movesInFlight.has(key)) return { _tag: "Cancelled" };
  movesInFlight.add(key);
  try {
    return await moveOnce(input);
  } finally {
    movesInFlight.delete(key);
  }
}

async function moveOnce(
  input: Parameters<typeof moveThreadToMachine>[0],
): Promise<ThreadMachineMoveOutcome> {
  const { registry, commands, source, target } = input;
  const settled = (result: AtomCommandResult<unknown, unknown>): ThreadMachineMoveOutcome =>
    isAtomCommandInterrupted(result)
      ? { _tag: "Cancelled" }
      : { _tag: "Failed", message: failureMessage(result) };

  const exported = await commands.exportThread.run(registry, {
    environmentId: source.environmentId,
    input: { threadId: source.threadId },
  });
  if (exported._tag !== "Success") return settled(exported);
  if (!(await input.confirm(exported.value))) return { _tag: "Cancelled" };

  const imported = await commands.importThread.run(registry, {
    environmentId: target.environmentId,
    input: {
      projectId: target.projectId,
      bundle: exported.value.bundle,
      movedFrom: input.sourceLabel,
      leftBehind: exported.value.leftBehind,
    },
  });
  if (imported._tag !== "Success") return settled(imported);
  const threadRef = { environmentId: target.environmentId, threadId: imported.value.threadId };

  const finished = await commands.finishThreadMove.run(registry, {
    environmentId: source.environmentId,
    input: {
      threadId: source.threadId,
      movedTo: input.targetLabel,
      revision: exported.value.revision,
    },
  });
  return {
    _tag: "Moved",
    threadRef,
    archiveError: finished._tag === "Success" ? null : failureMessage(finished),
  };
}
