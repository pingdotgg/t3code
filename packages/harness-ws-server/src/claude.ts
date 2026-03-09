import type {
  HarnessCapabilitySet,
  HarnessEvent,
  HarnessProfile,
  HarnessSession,
  HarnessSessionId,
} from "@t3tools/contracts";
import { HarnessSessionId as HarnessSessionIdSchema } from "@t3tools/contracts";
import {
  type HarnessAdapter,
  HarnessAdapterError,
  type HarnessCancelTurnInput,
  type HarnessCreateSessionInput,
  type HarnessEventStreamInput,
  type HarnessResolveElicitationInput,
  type HarnessResolvePermissionInput,
  type HarnessResumeSessionInput,
  type HarnessSendTurnInput,
  type HarnessShutdownSessionInput,
  type HarnessUpdateSessionConfigInput,
  assertHarness,
} from "./adapters";

export const CLAUDE_HARNESS_CAPABILITIES: HarnessCapabilitySet = {
  resume: true,
  cancel: true,
  modelSwitch: "restart-required",
  permissions: true,
  elicitation: true,
  toolLifecycle: true,
  reasoningStream: true,
  planStream: true,
  fileArtifacts: true,
  checkpoints: false,
  subagents: true,
};

export type ClaudeAgentSdkEvent = Omit<HarnessEvent, "harness" | "adapterKey" | "connectionMode">;

export interface ClaudeAgentSdkLike {
  createSession(input: HarnessCreateSessionInput): Promise<{ sessionId: string; title?: string }>;
  resumeSession(input: HarnessResumeSessionInput): Promise<void>;
  sendTurn(input: HarnessSendTurnInput): Promise<{ turnId?: string }>;
  cancelTurn(input: HarnessCancelTurnInput): Promise<void>;
  resolvePermission(input: HarnessResolvePermissionInput): Promise<void>;
  resolveElicitation(input: HarnessResolveElicitationInput): Promise<void>;
  updateSessionConfig(input: HarnessUpdateSessionConfigInput): Promise<void>;
  shutdownSession(input: HarnessShutdownSessionInput): Promise<void>;
  streamEvents(input: HarnessEventStreamInput): AsyncIterable<ClaudeAgentSdkEvent>;
}

export interface ClaudeHarnessAdapterOptions {
  readonly sdk: ClaudeAgentSdkLike;
  readonly adapterKey?: string;
}

function toHarnessSession(
  input: HarnessCreateSessionInput,
  sessionId: string,
  adapterKey: string,
  title?: string,
): HarnessSession {
  return {
    id: HarnessSessionIdSchema.makeUnsafe(sessionId),
    profileId: input.profile.id,
    harness: "claude-agent-sdk",
    adapterKey,
    connectionMode: input.profile.connectionMode,
    title: title ?? input.title ?? null,
    cwd: input.profile.config.claudeAgentSdk?.cwd ?? null,
    model: null,
    mode: input.profile.config.claudeAgentSdk?.sessionMode ?? null,
    state: "starting",
    activeTurnId: null,
    nativeSessionId: sessionId,
    lastError: null,
    capabilities: CLAUDE_HARNESS_CAPABILITIES,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createClaudeAgentSdkAdapter(
  options: ClaudeHarnessAdapterOptions,
): HarnessAdapter {
  const adapterKey = options.adapterKey ?? "claude-agent-sdk";
  return {
    key: adapterKey,
    harness: "claude-agent-sdk",
    family: "sdk",
    defaultConnectionMode: "spawned",
    capabilities: CLAUDE_HARNESS_CAPABILITIES,
    validateProfile(profile: HarnessProfile) {
      assertHarness(profile, "claude-agent-sdk");
    },
    async createSession(input) {
      this.validateProfile(input.profile);
      const created = await options.sdk.createSession(input);
      return toHarnessSession(input, created.sessionId, adapterKey, created.title);
    },
    async resumeSession(input) {
      await options.sdk.resumeSession(input);
      return input.session;
    },
    async sendTurn(input) {
      await options.sdk.sendTurn(input);
    },
    resolvePermission(input) {
      return options.sdk.resolvePermission(input);
    },
    resolveElicitation(input) {
      return options.sdk.resolveElicitation(input);
    },
    cancelTurn(input) {
      return options.sdk.cancelTurn(input);
    },
    updateSessionConfig(input) {
      return options.sdk.updateSessionConfig(input);
    },
    shutdownSession(input) {
      return options.sdk.shutdownSession(input);
    },
    async *streamEvents(input) {
      for await (const event of options.sdk.streamEvents(input)) {
        yield {
          ...event,
          harness: "claude-agent-sdk",
          adapterKey,
          connectionMode: input.session.connectionMode,
        } as HarnessEvent;
      }
    },
  };
}

export function assertClaudeSessionId(value: string | HarnessSessionId): HarnessSessionId {
  if (typeof value !== "string") {
    return value;
  }
  if (value.trim().length === 0) {
    throw new HarnessAdapterError("Claude session id must be non-empty.");
  }
  return HarnessSessionIdSchema.makeUnsafe(value);
}
