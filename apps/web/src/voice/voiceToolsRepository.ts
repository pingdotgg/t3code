import {
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type {
  BuiltFollowUpThreadInput,
  BuiltInterruptThreadInput,
  BuiltStartProjectTaskInput,
  ProjectTaskWorkspace,
} from "@t3tools/client-runtime/operations/thread-tasks";
import { makeSupervisorTargetVersion } from "@t3tools/client-runtime/operations/thread-supervisor";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { scopeProject, scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type CommandId,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { truncate } from "@t3tools/shared/String";
import * as Option from "effect/Option";

import { newCommandId, newMessageId, newThreadId, randomHex } from "../lib/utils";
import {
  buildVoiceTargetDisplayLabel,
  type VoiceCommandReceipt,
  type VoiceStartThreadPreparation,
  type VoiceSupervisorProjectRecord,
  type VoiceSupervisorRepository,
  type VoiceSupervisorThreadRecord,
} from "./voiceTools";

type MaybePromise<T> = T | Promise<T>;

export interface VoiceToolsWebEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: SupervisorConnectionState;
  readonly shellState: EnvironmentShellState;
}

export type VoiceWebStartWorkspaceDefaults =
  | {
      readonly mode: "local";
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }
  | {
      readonly mode: "worktree";
      readonly baseBranch: string;
      readonly startFromOrigin: boolean;
    };

export interface VoiceWebStartThreadDefaults {
  /** Fully resolved by the host from the same composer/project policy the user sees. */
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspace: VoiceWebStartWorkspaceDefaults;
}

export interface VoiceWebThreadNavigation {
  readonly to: "/$environmentId/$threadId";
  readonly params: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
}

/**
 * Existing environment command atoms resolve after the server transaction has
 * persisted its accepted command receipt; the sequence is that receipt's result.
 */
type DispatchAcceptance = AtomCommandResult<{ readonly sequence: number }, unknown>;

export interface VoiceToolsWebRepositoryDependencies {
  readonly readEnvironments: () => ReadonlyArray<VoiceToolsWebEnvironment>;
  readonly resolveStartThreadDefaults: (input: {
    readonly project: EnvironmentProject;
  }) => MaybePromise<VoiceWebStartThreadDefaults>;
  readonly navigate: (input: VoiceWebThreadNavigation) => MaybePromise<unknown>;
  readonly startThreadTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: BuiltStartProjectTaskInput | BuiltFollowUpThreadInput;
  }) => Promise<DispatchAcceptance>;
  readonly interruptThreadTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: BuiltInterruptThreadInput;
  }) => Promise<DispatchAcceptance>;
  readonly makeCommandId?: () => CommandId;
  readonly makeMessageId?: () => MessageId;
  readonly makeThreadId?: () => ThreadId;
  readonly now?: () => VoiceStartThreadPreparation["createdAt"];
  readonly randomHex?: (byteLength: number) => string;
}

function environmentAvailability(
  environment: VoiceToolsWebEnvironment,
): VoiceSupervisorProjectRecord["availability"] {
  const connectionPhase = connectionProjectionPhase(environment.connectionState);
  if (connectionPhase === "disconnected") return "disconnected";
  return connectionPhase === "ready" && environment.shellState.status === "live" ? "live" : "stale";
}

function targetAliases(title: string): ReadonlyArray<string> {
  return [title];
}

/**
 * Entity timestamps are advanced by authoritative shell upserts. Binding to
 * them keeps one target stable when an unrelated entity advances the global
 * shell sequence, while still invalidating confirmation after that target changes.
 */
function projectRecord(
  environment: VoiceToolsWebEnvironment,
  project: EnvironmentProject,
): VoiceSupervisorProjectRecord {
  return {
    project,
    displayLabel: buildVoiceTargetDisplayLabel(project.title, environment.label),
    version: makeSupervisorTargetVersion(
      JSON.stringify(["project", project.createdAt, project.updatedAt]),
    ),
    availability: environmentAvailability(environment),
    aliases: targetAliases(project.title),
  };
}

function threadRecord(
  environment: VoiceToolsWebEnvironment,
  thread: EnvironmentThreadShell,
): VoiceSupervisorThreadRecord {
  return {
    thread,
    displayLabel: buildVoiceTargetDisplayLabel(thread.title, environment.label),
    version: makeSupervisorTargetVersion(
      JSON.stringify(["thread", thread.createdAt, thread.updatedAt]),
    ),
    availability: environmentAvailability(environment),
    aliases: targetAliases(thread.title),
  };
}

function snapshotFor(environment: VoiceToolsWebEnvironment) {
  return Option.getOrNull(environment.shellState.snapshot);
}

function findEnvironment(
  environments: ReadonlyArray<VoiceToolsWebEnvironment>,
  environmentId: EnvironmentId,
): VoiceToolsWebEnvironment | null {
  return environments.find((environment) => environment.environmentId === environmentId) ?? null;
}

function acceptedReceipt(result: DispatchAcceptance): VoiceCommandReceipt {
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  return { status: "accepted" };
}

export function createVoiceToolsWebRepository(dependencies: VoiceToolsWebRepositoryDependencies) {
  const makeCommandId = dependencies.makeCommandId ?? newCommandId;
  const makeMessageId = dependencies.makeMessageId ?? newMessageId;
  const makeThreadId = dependencies.makeThreadId ?? newThreadId;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const makeRandomHex = dependencies.randomHex ?? randomHex;

  const listProjects = (): ReadonlyArray<VoiceSupervisorProjectRecord> => {
    const records: VoiceSupervisorProjectRecord[] = [];
    for (const environment of dependencies.readEnvironments()) {
      const snapshot = snapshotFor(environment);
      if (snapshot === null) continue;
      for (const project of snapshot.projects) {
        records.push(projectRecord(environment, scopeProject(environment.environmentId, project)));
      }
    }
    return records;
  };

  const listThreads = (): ReadonlyArray<VoiceSupervisorThreadRecord> => {
    const records: VoiceSupervisorThreadRecord[] = [];
    for (const environment of dependencies.readEnvironments()) {
      const snapshot = snapshotFor(environment);
      if (snapshot === null) continue;
      for (const thread of snapshot.threads) {
        records.push(
          threadRecord(environment, scopeThreadShell(environment.environmentId, thread)),
        );
      }
    }
    return records;
  };

  const getProject = (
    environmentId: EnvironmentId,
    projectId: EnvironmentProject["id"],
  ): VoiceSupervisorProjectRecord | null => {
    const environment = findEnvironment(dependencies.readEnvironments(), environmentId);
    const snapshot = environment === null ? null : snapshotFor(environment);
    const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
    return environment === null || project === undefined
      ? null
      : projectRecord(environment, scopeProject(environmentId, project));
  };

  const getThread = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ): VoiceSupervisorThreadRecord | null => {
    const environment = findEnvironment(dependencies.readEnvironments(), environmentId);
    const snapshot = environment === null ? null : snapshotFor(environment);
    const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
    return environment === null || thread === undefined
      ? null
      : threadRecord(environment, scopeThreadShell(environmentId, thread));
  };

  return {
    listProjects,
    listThreads,
    getProject,
    getThread,
    prepareStartThread: async ({ project, instruction, requestedTitle }) => {
      const defaults = await dependencies.resolveStartThreadDefaults({ project: project.project });
      const title = truncate(requestedTitle ?? instruction);
      const workspace: ProjectTaskWorkspace =
        defaults.workspace.mode === "local"
          ? defaults.workspace
          : {
              mode: "worktree",
              projectCwd: project.project.workspaceRoot,
              baseBranch: defaults.workspace.baseBranch,
              worktreeBranch: buildTemporaryWorktreeBranchName(makeRandomHex),
              startFromOrigin: defaults.workspace.startFromOrigin,
            };
      return {
        commandId: makeCommandId(),
        messageId: makeMessageId(),
        threadId: makeThreadId(),
        createdAt: now(),
        title,
        titleSeed: title,
        modelSelection: defaults.modelSelection,
        runtimeMode: defaults.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: defaults.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        workspace,
      };
    },
    prepareFollowUp: (_input) => ({
      commandId: makeCommandId(),
      messageId: makeMessageId(),
      createdAt: now(),
    }),
    prepareInterrupt: (_input) => ({
      commandId: makeCommandId(),
      createdAt: now(),
    }),
    openThread: async (record) => {
      await dependencies.navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: record.thread.environmentId,
          threadId: record.thread.id,
        },
      });
    },
    startThreadTurn: async ({ environmentId, command }) =>
      acceptedReceipt(await dependencies.startThreadTurn({ environmentId, input: command })),
    interruptThreadTurn: async ({ environmentId, command }) =>
      acceptedReceipt(await dependencies.interruptThreadTurn({ environmentId, input: command })),
  } satisfies VoiceSupervisorRepository;
}
