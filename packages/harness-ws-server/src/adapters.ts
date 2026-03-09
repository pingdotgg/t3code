import type {
  HarnessCapabilitySet,
  HarnessConnectionMode,
  HarnessEvent,
  HarnessKind,
  HarnessProfile,
  HarnessSession,
  HarnessSessionId,
  HarnessPermissionDecision,
  RuntimeRequestId,
  TurnId,
} from "@t3tools/contracts";

export type HarnessAdapterFamily = "process" | "sdk" | "bridge";

export interface HarnessCreateSessionInput {
  readonly profile: HarnessProfile;
  readonly title?: string;
}

export interface HarnessResumeSessionInput {
  readonly session: HarnessSession;
}

export interface HarnessSendTurnInput {
  readonly session: HarnessSession;
  readonly input?: string;
  readonly model?: string;
  readonly mode?: string;
}

export interface HarnessCancelTurnInput {
  readonly session: HarnessSession;
  readonly turnId?: TurnId;
}

export interface HarnessResolvePermissionInput {
  readonly session: HarnessSession;
  readonly requestId: RuntimeRequestId;
  readonly decision: HarnessPermissionDecision;
}

export interface HarnessResolveElicitationInput {
  readonly session: HarnessSession;
  readonly requestId: RuntimeRequestId;
  readonly answers: ReadonlyArray<ReadonlyArray<string>>;
}

export interface HarnessUpdateSessionConfigInput {
  readonly session: HarnessSession;
  readonly title?: string;
  readonly model?: string;
  readonly mode?: string;
}

export interface HarnessShutdownSessionInput {
  readonly session: HarnessSession;
}

export interface HarnessEventStreamInput {
  readonly session: HarnessSession;
  readonly signal?: AbortSignal;
}

export interface HarnessAdapter {
  readonly key: string;
  readonly harness: HarnessKind;
  readonly family: HarnessAdapterFamily;
  readonly defaultConnectionMode: HarnessConnectionMode;
  readonly capabilities: HarnessCapabilitySet;
  validateProfile(profile: HarnessProfile): void;
  createSession(input: HarnessCreateSessionInput): Promise<HarnessSession>;
  resumeSession(input: HarnessResumeSessionInput): Promise<HarnessSession>;
  sendTurn(input: HarnessSendTurnInput): Promise<void>;
  cancelTurn(input: HarnessCancelTurnInput): Promise<void>;
  resolvePermission(input: HarnessResolvePermissionInput): Promise<void>;
  resolveElicitation(input: HarnessResolveElicitationInput): Promise<void>;
  updateSessionConfig(input: HarnessUpdateSessionConfigInput): Promise<void>;
  shutdownSession(input: HarnessShutdownSessionInput): Promise<void>;
  streamEvents?(input: HarnessEventStreamInput): AsyncIterable<HarnessEvent>;
}

export class HarnessAdapterError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "HarnessAdapterError";
  }
}

export function assertHarness(profile: HarnessProfile, expected: HarnessKind): void {
  if (profile.harness !== expected) {
    throw new HarnessAdapterError(
      `Expected profile '${profile.id}' to target '${expected}', received '${profile.harness}'.`,
    );
  }
}

export function assertSessionHarness(session: HarnessSession, expected: HarnessKind): void {
  if (session.harness !== expected) {
    throw new HarnessAdapterError(
      `Expected session '${session.id}' to target '${expected}', received '${session.harness}'.`,
    );
  }
}

export function hasSessionId(
  sessionId: HarnessSessionId,
  events: ReadonlyArray<HarnessEvent>,
): boolean {
  return events.some((event) => event.sessionId === sessionId);
}
