// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { AgentScope, AgentScopeThreadId, RAISE_OOM_SCORE_LINE } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import { AcpProcessGroupTerminationError } from "./acpLinuxCgroup.ts";
import type {
  AcpLinuxCgroupController,
  AcpLinuxCgroupLease,
  AcpOwnedPosixProcess,
  AcpPosixOwnershipRoot,
  AcpPosixProcessIdentity,
  AcpPosixProcessTreeController,
} from "./acpLinuxCgroup.ts";
import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime.ts";

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
  readonly shell?: false;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly resumeMethod?: "load" | "resume";
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly interruptPromptOnCancel?: boolean;
  readonly cancelMeta?: EffectAcpSchema.CancelNotification["_meta"];
  readonly initializeMeta?: EffectAcpSchema.InitializeRequest["_meta"];
  readonly ownDetachedProcessGroup?: boolean;
  readonly ownDescendantProcessGroups?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly windowsProcessTreeTerminator?: (
    pid: number,
  ) => Effect.Effect<void, AcpProcessGroupTerminationError>;
  readonly posixProcessTreeController?: AcpPosixProcessTreeController;
  readonly linuxCgroupController?: AcpLinuxCgroupController | null;
  readonly cancelBehavior?: "interrupt" | "wait-for-prompt";
  readonly cancelTimeout?: Duration.Input;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  /** Authenticate before opening: Antigravity selects its credential source from the method. */
  readonly authenticateEagerly?: boolean;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  /** Sent on every session/new, load, resume and fork; omitting them clears an agent's stored roots. */
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Session `_meta`, chosen from the negotiated agent before each session setup or activation. */
  readonly sessionMeta?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => EffectAcpSchema.NewSessionRequest["_meta"] | undefined;
  readonly transformStdout?: EffectAcpClient.AcpClientOptions["transformStdout"];
  readonly transformSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  /** Redact secrets before logging. Failure closes the runtime. */
  readonly onStderr?: (text: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Disable only for non-interactive discovery that must surface auth-required immediately. */
  readonly authenticateOnAuthRequired?: boolean;
  readonly onInitialized?: (
    result: EffectAcpSchema.InitializeResponse,
  ) => Effect.Effect<void, never>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
  readonly onIncomingRequest?: EffectAcpClient.AcpClientOptions["onIncomingRequest"];
  readonly onTermination?: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly onOutgoingResponseFailure?: EffectAcpClient.AcpClientOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: EffectAcpClient.AcpClientOptions["onOutgoingResponse"];
  /** Unadvertised model IDs accepted by the config option; the agent validates them. */
  readonly customModels?: ReadonlyArray<string>;
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}


export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.ForkSessionResponse
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export interface AcpSessionActivationOptions {
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
}
