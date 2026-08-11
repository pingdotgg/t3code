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
import type { VoiceStartThreadPreparation } from "@t3tools/client-runtime/operations/voice-supervisor-tools";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { CommandId, MessageId, ThreadId, type EnvironmentId } from "@t3tools/contracts";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import { randomHex, uuidv4 } from "../lib/uuid";

type MaybePromise<T> = T | Promise<T>;
type DispatchAcceptance = AtomCommandResult<{ readonly sequence: number }, unknown>;

export type VoiceToolsMobileEnvironment = VoiceSupervisorEnvironment;

export type VoiceMobileStartWorkspaceDefaults = VoiceSupervisorStartWorkspaceDefaults;

export type VoiceMobileStartThreadDefaults = VoiceSupervisorStartThreadDefaults;

export interface VoiceMobileThreadNavigationParams {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface VoiceToolsMobileRepositoryDependencies {
  readonly readEnvironments: () => ReadonlyArray<VoiceToolsMobileEnvironment>;
  readonly resolveStartThreadDefaults: (input: {
    readonly project: EnvironmentProject;
  }) => MaybePromise<VoiceMobileStartThreadDefaults>;
  readonly navigate: (
    screen: "Thread",
    params: VoiceMobileThreadNavigationParams,
  ) => MaybePromise<unknown>;
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

/**
 * Binds the shared supervisor repository to mobile identity, title, navigation,
 * and live receipt-backed command APIs. Offline queuing is intentionally absent.
 */
export function createVoiceToolsMobileRepository(
  dependencies: VoiceToolsMobileRepositoryDependencies,
) {
  return createVoiceSupervisorRepository({
    readEnvironments: dependencies.readEnvironments,
    resolveStartThreadDefaults: dependencies.resolveStartThreadDefaults,
    openThread: ({ environmentId, threadId }) =>
      dependencies.navigate("Thread", { environmentId, threadId }),
    startThreadTurn: dependencies.startThreadTurn,
    interruptThreadTurn: dependencies.interruptThreadTurn,
    makeCommandId: dependencies.makeCommandId ?? (() => CommandId.make(uuidv4())),
    makeMessageId: dependencies.makeMessageId ?? (() => MessageId.make(uuidv4())),
    makeThreadId: dependencies.makeThreadId ?? (() => ThreadId.make(uuidv4())),
    now: dependencies.now ?? (() => new Date().toISOString()),
    randomHex: dependencies.randomHex ?? randomHex,
    formatTitle: deriveThreadTitleFromPrompt,
  });
}
