import type { VoiceStartThreadPreparation } from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import type {
  VoiceSupervisorEnvironment,
  VoiceSupervisorStartThreadDefaults,
  VoiceSupervisorStartWorkspaceDefaults,
} from "@t3tools/client-runtime/operations/voice-supervisor-repository";
import { createVoiceSupervisorRepository } from "@t3tools/client-runtime/operations/voice-supervisor-repository";
import type {
  BuiltFollowUpThreadInput,
  BuiltInterruptThreadInput,
  BuiltStartProjectTaskInput,
} from "@t3tools/client-runtime/operations/thread-tasks";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";

import { newCommandId, newMessageId, newThreadId, randomHex } from "../lib/utils";

type MaybePromise<T> = T | Promise<T>;

export type VoiceToolsWebEnvironment = VoiceSupervisorEnvironment;

export type VoiceWebStartWorkspaceDefaults = VoiceSupervisorStartWorkspaceDefaults;

export type VoiceWebStartThreadDefaults = VoiceSupervisorStartThreadDefaults;

export interface VoiceWebThreadNavigation {
  readonly to: "/$environmentId/$threadId";
  readonly params: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
}

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

export function createVoiceToolsWebRepository(dependencies: VoiceToolsWebRepositoryDependencies) {
  return createVoiceSupervisorRepository({
    readEnvironments: dependencies.readEnvironments,
    resolveStartThreadDefaults: dependencies.resolveStartThreadDefaults,
    openThread: ({ environmentId, threadId }) =>
      dependencies.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      }),
    startThreadTurn: dependencies.startThreadTurn,
    interruptThreadTurn: dependencies.interruptThreadTurn,
    makeCommandId: dependencies.makeCommandId ?? newCommandId,
    makeMessageId: dependencies.makeMessageId ?? newMessageId,
    makeThreadId: dependencies.makeThreadId ?? newThreadId,
    now: dependencies.now ?? (() => new Date().toISOString()),
    randomHex: dependencies.randomHex ?? randomHex,
    formatTitle: truncate,
  });
}
