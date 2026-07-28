// @effect-diagnostics globalTimers:off - This transport owns bounded WebSocket timers.
import {
  HermesGatewayEvent,
  HermesGatewayCronListResult,
  HermesGatewayCronMutationResult,
  HermesGatewayApprovalRespondResult,
  HermesGatewayClarificationRespondResult,
  HermesGatewayCommandsCatalogResult,
  HermesGatewayInboundFrame,
  HermesGatewayInterruptResult,
  HermesGatewayMutationOutcome,
  HermesGatewayMutationStatusResult,
  HermesGatewayModelOptionsResult,
  HermesGatewayPromptSubmitResult,
  HermesGatewaySessionCreateResult,
  HermesGatewaySessionHistoryResult,
  HermesGatewaySessionListResult,
  HermesGatewaySessionBranchResult,
  HermesGatewaySessionMcpLeaseResult,
  HermesGatewaySessionMcpRevokeResult,
  HermesGatewaySessionResumeResult,
  HermesGatewaySessionStatusResult,
  HermesGatewaySessionTitleResult,
  HermesGatewayReasoningConfigResult,
  HermesGatewayFastConfigResult,
  HermesGatewaySkillsInspectResult,
  HermesGatewaySkillsListResult,
  HermesGatewaySkillsReloadResult,
  HermesGatewaySkillsSearchResult,
  type HermesGatewayApprovalRespondParams,
  type HermesGatewayApprovalRespondResult as HermesGatewayApprovalRespondResultType,
  type HermesGatewayCapabilityName,
  type HermesGatewayCronListResult as HermesGatewayCronListResultType,
  type HermesGatewayCronMutationResult as HermesGatewayCronMutationResultType,
  type HermesGatewayCompatibility,
  type HermesGatewayClarificationRespondParams,
  type HermesGatewayClarificationRespondResult as HermesGatewayClarificationRespondResultType,
  type HermesGatewayCommandsCatalogResult as HermesGatewayCommandsCatalogResultType,
  type HermesGatewayEvent as HermesGatewayEventFrame,
  type HermesGatewayInterruptParams,
  type HermesGatewayInterruptResult as HermesGatewayInterruptResultType,
  type HermesGatewayPromptSubmitParams,
  type HermesGatewayPromptSubmitResult as HermesGatewayPromptSubmitResultType,
  type HermesGatewayReadyEvent,
  type HermesGatewayResponse,
  type HermesGatewayMutationStatusResult as HermesGatewayMutationStatusResultType,
  type HermesGatewayModelOptionsResult as HermesGatewayModelOptionsResultType,
  type HermesGatewayReasoningConfigResult as HermesGatewayReasoningConfigResultType,
  type HermesGatewayFastConfigResult as HermesGatewayFastConfigResultType,
  type HermesGatewaySessionCreateParams,
  type HermesGatewaySessionCreateResult as HermesGatewaySessionCreateResultType,
  type HermesGatewaySessionHandleParams,
  type HermesGatewaySessionHistoryResult as HermesGatewaySessionHistoryResultType,
  type HermesGatewaySessionListParams,
  type HermesGatewaySessionListResult as HermesGatewaySessionListResultType,
  type HermesGatewaySessionMcpLeaseResult as HermesGatewaySessionMcpLeaseResultType,
  type HermesGatewaySessionMcpParams,
  type HermesGatewaySessionMcpRevokeResult as HermesGatewaySessionMcpRevokeResultType,
  type HermesGatewaySessionBranchParams,
  type HermesGatewaySessionBranchResult as HermesGatewaySessionBranchResultType,
  type HermesGatewaySessionResumeParams,
  type HermesGatewaySessionResumeResult as HermesGatewaySessionResumeResultType,
  type HermesGatewaySessionStatusResult as HermesGatewaySessionStatusResultType,
  type HermesGatewaySessionTitleParams,
  type HermesGatewaySessionTitleResult as HermesGatewaySessionTitleResultType,
  type HermesGatewaySkillsInspectResult as HermesGatewaySkillsInspectResultType,
  type HermesGatewaySkillsListResult as HermesGatewaySkillsListResultType,
  type HermesGatewaySkillsReloadResult as HermesGatewaySkillsReloadResultType,
  type HermesGatewaySkillsSearchResult as HermesGatewaySkillsSearchResultType,
  type HermesGatewayUnknownRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  assessHermesConnectionSecurity,
  sanitizeHermesEndpoint,
} from "./HermesConnectionSecurity.ts";

export const HERMES_GATEWAY_SUPPORTED_PROTOCOL_MAJOR = 1;

export const HERMES_GATEWAY_LEGACY_CAPABILITIES =
  [] as const satisfies ReadonlyArray<HermesGatewayCapabilityName>;

export type HermesGatewayConnectionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export type HermesGatewayMutationState = "pending" | "confirmed" | "indeterminate" | "not_sent";

export interface HermesGatewayMutationRecord {
  readonly operationId: string;
  readonly method: string;
  readonly state: HermesGatewayMutationState;
  readonly mutationId?: string;
}

export interface HermesGatewayHealth {
  readonly state: HermesGatewayConnectionState;
  readonly reconnectAttempt: number;
  readonly protocolStatus: HermesGatewayCompatibility["status"] | "unknown";
  readonly protocolMajor: number | null;
  readonly protocolMinor: number | null;
  readonly serverVersion: string | null;
  readonly capabilities: ReadonlyArray<string>;
  readonly writesBlocked: boolean;
  readonly indeterminateMutationCount: number;
}

export interface HermesGatewayOrderedEvent {
  readonly transportSequence: number;
  readonly sessionSequence: number;
  readonly sessionId: string | undefined;
  readonly eventId: string | undefined;
  readonly eventSequence: number | undefined;
  readonly emittedAt: string | undefined;
  readonly sessionKey: string | undefined;
  readonly runId: string | undefined;
  readonly messageId: string | undefined;
  readonly cursor: string | number | undefined;
  readonly mutationId: string | undefined;
  readonly frame: HermesGatewayEventFrame;
}

export type HermesGatewayLogEvent =
  | {
      readonly type: "connection";
      readonly state: HermesGatewayConnectionState;
      readonly endpoint: string;
      readonly attempt: number;
    }
  | {
      readonly type: "request";
      readonly method: string;
      readonly requestId: string;
      readonly operation: "read" | "mutation";
    }
  | {
      readonly type: "response";
      readonly method: string;
      readonly requestId: string;
      readonly outcome: "success" | "rpc_error";
      readonly errorCode?: number;
    }
  | {
      readonly type: "protocol";
      readonly outcome: "invalid_frame" | "unknown_notification" | "capability_degraded";
      readonly method?: string;
      readonly capability?: string;
    }
  | {
      readonly type: "mutation";
      readonly operationId: string;
      readonly method: string;
      readonly state: HermesGatewayMutationState;
    };

export interface HermesGatewaySupervisor {
  readonly beforeConnect?: (context: {
    readonly attempt: number;
    readonly reconnect: boolean;
  }) => void | Promise<void>;
  readonly onConnected?: (context: {
    readonly attempt: number;
    readonly reconnect: boolean;
    readonly compatibility: HermesGatewayCompatibility;
  }) => void | Promise<void>;
  readonly onDisconnected?: (context: {
    readonly reconnecting: boolean;
    readonly pendingReads: number;
    readonly indeterminateMutations: ReadonlyArray<string>;
  }) => void | Promise<void>;
  readonly onReconnectExhausted?: (context: { readonly attempts: number }) => void | Promise<void>;
}

export interface HermesGatewaySocketEvent {
  readonly data?: unknown;
  readonly code?: number;
}

export interface HermesGatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: HermesGatewaySocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
}

export type HermesGatewaySocketFactory = (endpoint: string) => HermesGatewaySocket;

export interface HermesGatewayClientOptions {
  readonly endpoint: string;
  readonly authToken: string;
  readonly socketFactory?: HermesGatewaySocketFactory;
  readonly requestTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly openTimeoutMs?: number;
  readonly reconnect?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
  };
  readonly criticalCapabilities?: ReadonlyArray<string>;
  readonly logger?: (event: HermesGatewayLogEvent) => void;
  readonly supervisor?: HermesGatewaySupervisor;
}

export interface HermesGatewayReadOptions {
  readonly signal?: AbortSignal;
  readonly requiredCapability?: string;
  readonly retryOnReconnect?: boolean;
  readonly timeoutMs?: number;
}

export interface HermesGatewayMutationOptions {
  readonly operationId: string;
  readonly mutationId?: string;
  readonly signal?: AbortSignal;
  readonly requiredCapability?: string;
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly id: string;
  readonly method: string;
  readonly params: HermesGatewayUnknownRecord;
  readonly operation: "read" | "mutation";
  readonly operationId: string | undefined;
  readonly mutationId: string | undefined;
  readonly requiredCapability: string | undefined;
  readonly retryOnReconnect: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  sent: boolean;
  awaitingReconnect: boolean;
  timeoutMs: number;
}

interface ReadyWaiter {
  readonly resolve: (event: HermesGatewayReadyEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class HermesGatewayConfigurationError extends Error {
  override readonly name: string = "HermesGatewayConfigurationError";
}

/**
 * A mutation reused an operationId that this client already fenced. Callers
 * can treat this as caller input error, unlike other configuration failures.
 */
export class HermesGatewayDuplicateOperationIdError extends HermesGatewayConfigurationError {
  override readonly name: string = "HermesGatewayDuplicateOperationIdError";
}

export class HermesGatewayConnectionError extends Error {
  override readonly name = "HermesGatewayConnectionError";
}

export class HermesGatewayProtocolError extends Error {
  override readonly name = "HermesGatewayProtocolError";
}

export class HermesGatewayCapabilityError extends Error {
  override readonly name = "HermesGatewayCapabilityError";
  readonly capability: string;
  constructor(capability: string) {
    super(`Hermes gateway capability is unavailable: ${capability}`);
    this.capability = capability;
  }
}

export class HermesGatewayRpcError extends Error {
  override readonly name = "HermesGatewayRpcError";
  readonly code: number;
  readonly method: string;
  readonly disposition: "retryable" | "indeterminate" | "fatal" | undefined;
  constructor(
    code: number,
    method: string,
    disposition: "retryable" | "indeterminate" | "fatal" | undefined,
  ) {
    super(`Hermes gateway RPC ${method} failed with code ${code}.`);
    this.code = code;
    this.method = method;
    this.disposition = disposition;
  }
}

export class HermesGatewayRequestCancelledError extends Error {
  override readonly name = "HermesGatewayRequestCancelledError";
}

export class HermesGatewayMutationIndeterminateError extends Error {
  override readonly name = "HermesGatewayMutationIndeterminateError";
  readonly operationId: string;
  readonly method: string;
  constructor(operationId: string, method: string) {
    super(`Hermes mutation ${operationId} (${method}) has an indeterminate outcome.`);
    this.operationId = operationId;
    this.method = method;
  }
}

export class HermesGatewayMutationsBlockedError extends Error {
  override readonly name = "HermesGatewayMutationsBlockedError";
  readonly operationIds: ReadonlyArray<string>;
  constructor(operationIds: ReadonlyArray<string>) {
    super("Hermes mutations are blocked until indeterminate operations are reconciled.");
    this.operationIds = operationIds;
  }
}

const decodeInboundFrame = Schema.decodeUnknownSync(HermesGatewayInboundFrame);
const decodeGatewayEvent = Schema.decodeUnknownSync(HermesGatewayEvent);
const decodeMutationOutcome = Schema.decodeUnknownSync(HermesGatewayMutationOutcome);

const METHOD_CAPABILITIES: Readonly<Record<string, string>> = {
  "session.create": "session.lifecycle",
  "session.list": "session.lifecycle",
  "session.resume": "session.lifecycle",
  "session.history": "session.history",
  "session.title": "session.title",
  "session.branch": "session.branch.latest",
  "session.mcp.register": "session_mcp",
  "session.mcp.replace": "session_mcp",
  "session.mcp.revoke": "session_mcp",
  "session.interrupt": "turn.interrupt",
  "prompt.submit": "turn.prompt",
  "mutation.status": "mutation.stable_ids",
  "commands.catalog": "commands.catalog",
  "model.options": "models.inventory",
  "config.get": "reasoning.effective_state",
  "image.attach_bytes": "attachments.image",
  "file.attach": "attachments.file",
  "pdf.attach": "attachments.pdf",
  "approval.respond": "events.approvals",
  "clarify.respond": "events.clarification",
  "cron.manage": "cron.manage",
  "skills.manage": "skills.manage",
  "skills.reload": "skills.reload",
};

const SOCKET_OPEN = 1;

function readyVersionFields(
  payload: HermesGatewayReadyEvent["params"]["payload"],
): Pick<HermesGatewayCompatibility, "serverVersion" | "revision"> {
  return {
    ...(payload.server_version === undefined ? {} : { serverVersion: payload.server_version }),
    ...(payload.revision === undefined ? {} : { revision: payload.revision }),
  };
}

export function classifyHermesGatewayReady(
  event: HermesGatewayReadyEvent,
): HermesGatewayCompatibility {
  const protocol = event.params.payload.protocol ?? null;
  const advertised = protocol?.capabilities ?? event.params.payload.capabilities;
  const capabilities =
    advertised === undefined
      ? [...HERMES_GATEWAY_LEGACY_CAPABILITIES]
      : Array.isArray(advertised)
        ? [...advertised]
        : Object.entries(advertised)
            .filter(([capability, value]) => capability !== "version" && capabilityEnabled(value))
            .map(([capability]) => capability)
            .toSorted();

  if (protocol === null) {
    return {
      status: "legacy",
      protocol: null,
      capabilities,
      inventory: advertised ?? null,
      reason: "Gateway did not advertise a negotiated protocol version.",
      ...readyVersionFields(event.params.payload),
    };
  }
  if (protocol.major !== HERMES_GATEWAY_SUPPORTED_PROTOCOL_MAJOR) {
    return {
      status: "unsupported",
      protocol,
      capabilities,
      inventory: advertised ?? null,
      reason: `Unsupported Hermes gateway protocol major ${protocol.major}.`,
      ...readyVersionFields(event.params.payload),
    };
  }
  return {
    status: "supported",
    protocol,
    capabilities,
    inventory: advertised ?? null,
    reason: `Hermes gateway protocol ${protocol.major}.${protocol.minor} is supported.`,
    ...readyVersionFields(event.params.payload),
  };
}

export function sanitizeHermesGatewayEndpoint(endpoint: string): string {
  return sanitizeHermesEndpoint(endpoint);
}

export class HermesGatewayClient {
  private readonly endpoint: string;
  private readonly endpointLabel: string;
  private readonly socketFactory: HermesGatewaySocketFactory;
  private readonly requestTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly criticalCapabilities: ReadonlyArray<string>;
  private readonly logger: ((event: HermesGatewayLogEvent) => void) | undefined;
  private readonly supervisor: HermesGatewaySupervisor | undefined;

  private socket: HermesGatewaySocket | undefined;
  private stateValue: HermesGatewayConnectionState = "disconnected";
  private compatibilityValue: HermesGatewayCompatibility | undefined;
  private capabilities = new Set<string>();
  private nextRequestId = 1;
  private transportSequence = 0;
  private readonly sessionSequences = new Map<string, number>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly mutations = new Map<string, HermesGatewayMutationRecord>();
  private readonly eventListeners = new Set<
    (event: HermesGatewayOrderedEvent) => void | Promise<void>
  >();
  private eventDispatch = Promise.resolve();
  private readyWaiter: ReadyWaiter | undefined;
  private connectTask: Promise<HermesGatewayCompatibility> | undefined;
  private reconnectTask: Promise<void> | undefined;
  private manuallyClosed = false;
  private connectionGeneration = 0;
  private reconnectAttempt = 0;
  private readonly healthListeners = new Set<(health: HermesGatewayHealth) => void>();

  constructor(options: HermesGatewayClientOptions) {
    this.endpoint = authenticatedEndpoint(options);
    this.endpointLabel = sanitizeHermesGatewayEndpoint(this.endpoint);
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.requestTimeoutMs = positive(options.requestTimeoutMs, 15_000);
    this.readyTimeoutMs = positive(options.readyTimeoutMs, 10_000);
    this.openTimeoutMs = positive(options.openTimeoutMs, 10_000);
    this.maxReconnectAttempts = nonNegative(options.reconnect?.maxAttempts, 3);
    this.reconnectBaseDelayMs = positive(options.reconnect?.baseDelayMs, 100);
    this.reconnectMaxDelayMs = positive(options.reconnect?.maxDelayMs, 2_000);
    this.criticalCapabilities = options.criticalCapabilities ?? [];
    this.logger = options.logger;
    this.supervisor = options.supervisor;
  }

  get state(): HermesGatewayConnectionState {
    return this.stateValue;
  }

  get compatibility(): HermesGatewayCompatibility | undefined {
    return this.compatibilityValue;
  }

  get writesBlocked(): boolean {
    return this.indeterminateOperationIds().length > 0;
  }

  get health(): HermesGatewayHealth {
    return {
      state: this.stateValue,
      reconnectAttempt: this.reconnectAttempt,
      protocolStatus: this.compatibilityValue?.status ?? "unknown",
      protocolMajor: this.compatibilityValue?.protocol?.major ?? null,
      protocolMinor: this.compatibilityValue?.protocol?.minor ?? null,
      serverVersion: this.compatibilityValue?.serverVersion ?? null,
      capabilities: [...this.capabilities].toSorted(),
      writesBlocked: this.writesBlocked,
      indeterminateMutationCount: this.indeterminateOperationIds().length,
    };
  }

  hasCapability(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  mutationRecord(operationId: string): HermesGatewayMutationRecord | undefined {
    return this.mutations.get(operationId);
  }

  onEvent(listener: (event: HermesGatewayOrderedEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onHealthChange(listener: (health: HermesGatewayHealth) => void): () => void {
    this.healthListeners.add(listener);
    listener(this.health);
    return () => this.healthListeners.delete(listener);
  }

  async connect(): Promise<HermesGatewayCompatibility> {
    if (this.stateValue === "ready" && this.compatibilityValue) {
      return this.compatibilityValue;
    }
    if (this.stateValue === "closed") {
      throw new HermesGatewayConnectionError("Hermes gateway client is closed.");
    }
    if (this.connectTask) return this.connectTask;
    if (this.reconnectTask) {
      await this.reconnectTask;
      if (this.stateValue === "ready" && this.compatibilityValue) {
        return this.compatibilityValue;
      }
      throw new HermesGatewayConnectionError("Hermes gateway reconnect did not recover.");
    }
    this.manuallyClosed = false;
    const task = this.connectAttempt(0, false).finally(() => {
      if (this.connectTask === task) this.connectTask = undefined;
    });
    this.connectTask = task;
    return task;
  }

  async read(
    method: string,
    params: HermesGatewayUnknownRecord,
    options: HermesGatewayReadOptions = {},
  ): Promise<unknown> {
    const requiredCapability = options.requiredCapability ?? METHOD_CAPABILITIES[method];
    this.requireCapability(requiredCapability);
    return this.sendRequest(method, params, {
      operation: "read",
      operationId: undefined,
      mutationId: undefined,
      requiredCapability,
      signal: options.signal,
      retryOnReconnect: options.retryOnReconnect ?? true,
      timeoutMs: positive(options.timeoutMs, this.requestTimeoutMs),
    });
  }

  async mutate(
    method: string,
    params: HermesGatewayUnknownRecord,
    options: HermesGatewayMutationOptions,
  ): Promise<unknown> {
    return this.mutateDecoded(method, params, options, (value) => value);
  }

  private async mutateDecoded<Result>(
    method: string,
    params: HermesGatewayUnknownRecord,
    options: HermesGatewayMutationOptions,
    decode: (value: unknown) => Result,
  ): Promise<Result> {
    const requiredCapability = options.requiredCapability ?? METHOD_CAPABILITIES[method];
    this.requireCapability(requiredCapability);
    const blocked = this.indeterminateOperationIds();
    if (blocked.length > 0) {
      throw new HermesGatewayMutationsBlockedError(blocked);
    }
    if (!options.operationId.trim()) {
      throw new HermesGatewayConfigurationError("Hermes mutation operationId is required.");
    }
    const existing = this.mutations.get(options.operationId);
    const retryingKnownUnsent =
      existing?.state === "not_sent" &&
      existing.method === method &&
      existing.mutationId === options.mutationId;
    if (existing !== undefined && !retryingKnownUnsent) {
      throw new HermesGatewayDuplicateOperationIdError(
        `Hermes mutation operationId has already been used: ${options.operationId}`,
      );
    }
    if (options.mutationId && !this.hasCapability("mutation.stable_ids")) {
      throw new HermesGatewayCapabilityError("mutation.stable_ids");
    }

    const wireParams =
      options.mutationId === undefined
        ? params
        : {
            ...params,
            mutation_id: options.mutationId,
          };
    this.setMutation({
      operationId: options.operationId,
      method,
      state: "pending",
      ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
    });

    let responseReceived = false;
    try {
      const result = await this.sendRequest(method, wireParams, {
        operation: "mutation",
        operationId: options.operationId,
        mutationId: options.mutationId,
        requiredCapability,
        signal: options.signal,
        retryOnReconnect: false,
        timeoutMs: positive(options.timeoutMs, this.requestTimeoutMs),
      });
      responseReceived = true;
      const outcome = decodeOptionalMutationOutcome(result);
      if (outcome?.mutation_status === "indeterminate") {
        this.markMutationIndeterminate(options.operationId);
        throw new HermesGatewayMutationIndeterminateError(options.operationId, method);
      }
      if (outcome?.mutation_status === "completed") {
        this.confirmMutation(options.operationId);
      }
      const decoded = decode(result);
      this.confirmMutation(options.operationId);
      return decoded;
    } catch (error) {
      const record = this.mutations.get(options.operationId);
      if (record?.state === "pending") {
        this.setMutation({
          ...record,
          state: responseReceived ? "indeterminate" : "not_sent",
        });
        if (responseReceived) {
          throw new HermesGatewayMutationIndeterminateError(options.operationId, method);
        }
      }
      throw error;
    }
  }

  async interrupt(
    sessionId: string,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayInterruptResultType> {
    return this.interruptSession({ session_id: sessionId }, options);
  }

  async createSession(
    params: HermesGatewaySessionCreateParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionCreateResultType> {
    return this.mutateDecoded(
      "session.create",
      params,
      {
        ...options,
        requiredCapability: "session.lifecycle",
      },
      (result) => decodeResult(HermesGatewaySessionCreateResult, result, "session.create"),
    );
  }

  async resumeSession(
    params: HermesGatewaySessionResumeParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionResumeResultType> {
    return this.mutateDecoded(
      "session.resume",
      params,
      {
        ...options,
        requiredCapability: "session.lifecycle",
      },
      (result) => decodeResult(HermesGatewaySessionResumeResult, result, "session.resume"),
    );
  }

  async registerSessionMcp(
    params: HermesGatewaySessionMcpParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionMcpLeaseResultType> {
    return this.mutateDecoded(
      "session.mcp.register",
      params,
      { ...options, requiredCapability: "session_mcp" },
      (result) => decodeResult(HermesGatewaySessionMcpLeaseResult, result, "session.mcp.register"),
    );
  }

  async replaceSessionMcp(
    params: HermesGatewaySessionMcpParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionMcpLeaseResultType> {
    return this.mutateDecoded(
      "session.mcp.replace",
      params,
      { ...options, requiredCapability: "session_mcp" },
      (result) => decodeResult(HermesGatewaySessionMcpLeaseResult, result, "session.mcp.replace"),
    );
  }

  async revokeSessionMcp(
    sessionId: string,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionMcpRevokeResultType> {
    return this.mutateDecoded(
      "session.mcp.revoke",
      { session_id: sessionId },
      { ...options, requiredCapability: "session_mcp" },
      (result) => decodeResult(HermesGatewaySessionMcpRevokeResult, result, "session.mcp.revoke"),
    );
  }

  async readSessionStatus(
    params: HermesGatewaySessionHandleParams,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySessionStatusResultType> {
    const result = await this.read("session.status", params, {
      ...options,
      requiredCapability: "session.lifecycle",
    });
    return decodeResult(HermesGatewaySessionStatusResult, result, "session.status");
  }

  async readSessionHistory(
    params: HermesGatewaySessionHandleParams,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySessionHistoryResultType> {
    const result = await this.read("session.history", params, {
      ...options,
      requiredCapability: "session.history",
    });
    return decodeResult(HermesGatewaySessionHistoryResult, result, "session.history");
  }

  async readSessionTitle(
    params: Pick<HermesGatewaySessionTitleParams, "session_id">,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySessionTitleResultType> {
    const result = await this.read("session.title", params, {
      ...options,
      requiredCapability: "session.title",
    });
    return decodeResult(HermesGatewaySessionTitleResult, result, "session.title");
  }

  async updateSessionTitle(
    params: HermesGatewaySessionTitleParams & { readonly title: string },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionTitleResultType> {
    return this.mutateDecoded(
      "session.title",
      params,
      {
        ...options,
        requiredCapability: "session.title",
      },
      (result) => decodeResult(HermesGatewaySessionTitleResult, result, "session.title"),
    );
  }

  async branchSession(
    params: HermesGatewaySessionBranchParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionBranchResultType> {
    return this.mutateDecoded(
      "session.branch",
      params,
      {
        ...options,
        requiredCapability: "session.branch.latest",
      },
      (result) => decodeResult(HermesGatewaySessionBranchResult, result, "session.branch"),
    );
  }

  async listSessions(
    params: HermesGatewaySessionListParams,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySessionListResultType> {
    const result = await this.read("session.list", params, {
      ...options,
      requiredCapability: "session.lifecycle",
      retryOnReconnect: true,
    });
    return decodeResult(HermesGatewaySessionListResult, result, "session.list");
  }

  async listCronJobs(
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewayCronListResultType> {
    const result = await this.read(
      "cron.manage",
      { action: "list" },
      {
        ...options,
        requiredCapability: "cron.read",
      },
    );
    return decodeResult(HermesGatewayCronListResult, result, "cron.manage/list");
  }

  async manageCron(
    params: HermesGatewayUnknownRecord,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayCronMutationResultType> {
    return this.mutateDecoded(
      "cron.manage",
      params,
      { ...options, requiredCapability: "cron.manage" },
      (result) => decodeResult(HermesGatewayCronMutationResult, result, "cron.manage"),
    );
  }

  async listSkills(
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySkillsListResultType> {
    const result = await this.read(
      "skills.manage",
      { action: "list" },
      { ...options, requiredCapability: "skills.manage" },
    );
    return decodeResult(HermesGatewaySkillsListResult, result, "skills.manage/list");
  }

  async searchSkills(
    query: string,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySkillsSearchResultType> {
    const result = await this.read(
      "skills.manage",
      { action: "search", query },
      { ...options, requiredCapability: "skills.manage" },
    );
    return decodeResult(HermesGatewaySkillsSearchResult, result, "skills.manage/search");
  }

  async inspectSkill(
    name: string,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewaySkillsInspectResultType> {
    const result = await this.read(
      "skills.manage",
      { action: "inspect", query: name },
      { ...options, requiredCapability: "skills.manage" },
    );
    return decodeResult(HermesGatewaySkillsInspectResult, result, "skills.manage/inspect");
  }

  async reloadSkills(
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySkillsReloadResultType> {
    return this.mutateDecoded(
      "skills.reload",
      {},
      { ...options, requiredCapability: "skills.reload" },
      (result) => decodeResult(HermesGatewaySkillsReloadResult, result, "skills.reload"),
    );
  }

  async readCommandsCatalog(
    sessionId?: string,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewayCommandsCatalogResultType> {
    const result = await this.read(
      "commands.catalog",
      sessionId === undefined ? {} : { session_id: sessionId },
      { ...options, requiredCapability: "commands.catalog" },
    );
    return decodeResult(HermesGatewayCommandsCatalogResult, result, "commands.catalog");
  }

  async readModelOptions(
    params: {
      readonly session_id?: string;
      readonly explicit_only?: boolean;
      readonly include_unconfigured?: boolean;
    } = {},
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewayModelOptionsResultType> {
    const result = await this.read("model.options", params, {
      ...options,
      requiredCapability: "models.inventory",
    });
    return decodeResult(HermesGatewayModelOptionsResult, result, "model.options");
  }

  async readReasoningConfig(
    sessionId?: string,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewayReasoningConfigResultType> {
    const result = await this.read(
      "config.get",
      {
        key: "reasoning",
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      },
      { ...options, requiredCapability: "reasoning.effective_state" },
    );
    return decodeResult(HermesGatewayReasoningConfigResult, result, "config.get");
  }

  async readFastConfig(
    sessionId?: string,
    options: Omit<HermesGatewayReadOptions, "requiredCapability"> = {},
  ): Promise<HermesGatewayFastConfigResultType> {
    const result = await this.read(
      "config.get",
      {
        key: "fast",
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      },
      { ...options, requiredCapability: "models.inventory" },
    );
    return decodeResult(HermesGatewayFastConfigResult, result, "config.get");
  }

  async reconcileMutation(
    operationId: string,
    mutationId?: string,
  ): Promise<HermesGatewayMutationStatusResultType> {
    const trackedMutationId = this.mutations.get(operationId)?.mutationId ?? operationId;
    const wireMutationId = mutationId ?? trackedMutationId;
    const result = await this.read(
      "mutation.status",
      { mutation_id: wireMutationId },
      {
        requiredCapability: "mutation.stable_ids",
        retryOnReconnect: true,
      },
    );
    const outcome = decodeResult(HermesGatewayMutationStatusResult, result, "mutation.status");
    if (wireMutationId !== trackedMutationId) return outcome;
    const existing = this.mutations.get(operationId);
    if (outcome.mutation_status === "indeterminate") {
      this.setMutation({
        operationId,
        method: existing?.method ?? "unknown",
        state: "indeterminate",
        mutationId: existing?.mutationId ?? operationId,
      });
    } else if (outcome.mutation_status === "completed") {
      if (this.mutations.delete(operationId)) this.emitHealth();
    } else {
      this.setMutation({
        operationId,
        method: existing?.method ?? "unknown",
        state: "pending",
        mutationId: existing?.mutationId ?? operationId,
      });
    }
    return outcome;
  }

  async submitPrompt(
    params: HermesGatewayPromptSubmitParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayPromptSubmitResultType> {
    return this.mutateDecoded(
      "prompt.submit",
      params,
      {
        ...options,
        requiredCapability: "turn.prompt",
      },
      (result) => decodeResult(HermesGatewayPromptSubmitResult, result, "prompt.submit"),
    );
  }

  async attachImageBytes(
    params: {
      readonly session_id: string;
      readonly content_base64: string;
      readonly filename?: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown> {
    return this.mutate("image.attach_bytes", params, {
      ...options,
      requiredCapability: "attachments.image",
    });
  }

  async respondToApproval(
    params: HermesGatewayApprovalRespondParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayApprovalRespondResultType> {
    return this.mutateDecoded(
      "approval.respond",
      params,
      { ...options, requiredCapability: "events.approvals" },
      (result) => decodeResult(HermesGatewayApprovalRespondResult, result, "approval.respond"),
    );
  }

  async respondToClarification(
    params: HermesGatewayClarificationRespondParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayClarificationRespondResultType> {
    return this.mutateDecoded(
      "clarify.respond",
      params,
      { ...options, requiredCapability: "events.clarification" },
      (result) => decodeResult(HermesGatewayClarificationRespondResult, result, "clarify.respond"),
    );
  }

  async attachFile(
    params: {
      readonly session_id: string;
      readonly name: string;
      readonly data_url: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown> {
    return this.mutate("file.attach", params, {
      ...options,
      requiredCapability: "attachments.file",
    });
  }

  async attachPdf(
    params: {
      readonly session_id: string;
      readonly filename: string;
      readonly content_base64: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown> {
    return this.mutate("pdf.attach", params, {
      ...options,
      requiredCapability: "attachments.pdf",
    });
  }

  async interruptSession(
    params: HermesGatewayInterruptParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayInterruptResultType> {
    return this.mutateDecoded(
      "session.interrupt",
      params,
      {
        ...options,
        requiredCapability: "turn.interrupt",
      },
      (result) => decodeResult(HermesGatewayInterruptResult, result, "session.interrupt"),
    );
  }

  acknowledgeIndeterminate(operationId: string): void {
    const record = this.mutations.get(operationId);
    if (record?.state !== "indeterminate") {
      throw new HermesGatewayConfigurationError(
        `Hermes mutation is not indeterminate: ${operationId}`,
      );
    }
    this.mutations.delete(operationId);
    this.emitHealth();
  }

  close(): void {
    if (this.stateValue === "closed") return;
    this.manuallyClosed = true;
    this.setState("closed", 0);
    this.rejectReady(new HermesGatewayConnectionError("Hermes gateway client closed."));
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client closed");
    for (const pending of this.pending.values()) {
      const sentMutation = pending.operation === "mutation" && pending.sent;
      this.rejectPending(
        pending,
        sentMutation && pending.operationId
          ? new HermesGatewayMutationIndeterminateError(pending.operationId, pending.method)
          : new HermesGatewayConnectionError("Hermes gateway client closed."),
        sentMutation,
      );
    }
  }

  private async connectAttempt(
    attempt: number,
    reconnect: boolean,
  ): Promise<HermesGatewayCompatibility> {
    this.setState(reconnect ? "reconnecting" : "connecting", attempt);
    const generationBefore = this.connectionGeneration;
    await this.supervisor?.beforeConnect?.({ attempt, reconnect });
    if (this.manuallyClosed || generationBefore !== this.connectionGeneration) {
      throw new HermesGatewayConnectionError("Hermes gateway client closed.");
    }
    const generation = ++this.connectionGeneration;
    let socket: HermesGatewaySocket;
    try {
      socket = this.socketFactory(this.endpoint);
    } catch (error) {
      if (!reconnect) this.setState("disconnected", attempt);
      throw error instanceof Error
        ? error
        : new HermesGatewayConnectionError("Hermes gateway socket creation failed.");
    }
    this.socket = socket;

    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new HermesGatewayConnectionError("Timed out opening gateway connection.")),
        this.openTimeoutMs,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new HermesGatewayConnectionError("Hermes gateway connection failed."));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new HermesGatewayConnectionError("Hermes gateway connection closed."));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => this.handleMessage(event, generation));
    socket.addEventListener("close", (event) => this.handleClose(event, generation), {
      once: true,
    });

    try {
      await opened;
      this.ensureAttemptActive(generation);
      const ready = await this.waitForReady();
      this.ensureAttemptActive(generation);
      const compatibility = classifyHermesGatewayReady(ready);
      this.compatibilityValue = compatibility;
      if (compatibility.status === "unsupported") {
        throw new HermesGatewayProtocolError(compatibility.reason);
      }
      this.capabilities = new Set(compatibility.capabilities);
      for (const capability of this.criticalCapabilities) {
        this.requireCapability(capability);
      }
      this.setState("ready", attempt);
      await this.supervisor?.onConnected?.({ attempt, reconnect, compatibility });
      this.ensureAttemptActive(generation);
      this.replayPendingReads();
      return compatibility;
    } catch (error) {
      if (this.socket === socket) this.socket = undefined;
      // The WHATWG WebSocket API only permits callers to send code 1000 or
      // private-use codes in the 3000-4999 range. Undici correctly rejects
      // reserved protocol code 1002 with InvalidAccessError, which would mask
      // the actual handshake/connection failure we are trying to report.
      socket.close(4002, "gateway handshake failed");
      this.rejectReady(
        error instanceof Error
          ? error
          : new HermesGatewayConnectionError("Hermes gateway handshake failed."),
      );
      if (generation === this.connectionGeneration && !this.manuallyClosed) {
        this.connectionGeneration += 1;
        if (this.stateValue === "connecting" || this.stateValue === "ready") {
          this.handleConnectionFailure();
        }
      }
      throw error;
    }
  }

  private ensureAttemptActive(generation: number): void {
    if (this.manuallyClosed || generation !== this.connectionGeneration) {
      throw new HermesGatewayConnectionError("Hermes gateway client closed.");
    }
  }

  private waitForReady(): Promise<HermesGatewayReadyEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = undefined;
        reject(new HermesGatewayProtocolError("Timed out waiting for gateway.ready."));
      }, this.readyTimeoutMs);
      this.readyWaiter = { resolve, reject, timer };
    });
  }

  private resolveReady(event: HermesGatewayReadyEvent): void {
    const waiter = this.readyWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.readyWaiter = undefined;
    waiter.resolve(event);
  }

  private rejectReady(error: Error): void {
    const waiter = this.readyWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.readyWaiter = undefined;
    waiter.reject(error);
  }

  private handleMessage(event: HermesGatewaySocketEvent, generation: number): void {
    if (generation !== this.connectionGeneration || typeof event.data !== "string") return;
    let decoded: HermesGatewayInboundFrame;
    try {
      decoded = decodeInboundFrame(JSON.parse(event.data));
    } catch {
      this.logger?.({ type: "protocol", outcome: "invalid_frame" });
      return;
    }

    if ("method" in decoded) {
      if (decoded.method !== "event") {
        this.logger?.({
          type: "protocol",
          outcome: "unknown_notification",
          method: decoded.method,
        });
        return;
      }
      const gatewayEvent = decodeGatewayEvent(decoded);
      if (gatewayEvent.params.type === "gateway.ready") {
        this.resolveReady(decoded as HermesGatewayReadyEvent);
      }
      this.enqueueEvent(gatewayEvent);
      return;
    }
    this.handleResponse(decoded);
  }

  private handleResponse(response: HermesGatewayResponse): void {
    if (response.id === null) return;
    const requestId = String(response.id);
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    this.clearPendingResources(pending);

    if ("error" in response) {
      const disposition = response.error.data?.disposition;
      const capability = pending.requiredCapability ?? METHOD_CAPABILITIES[pending.method];
      if (response.error.code === -32601 && capability && this.capabilities.delete(capability)) {
        this.logger?.({
          type: "protocol",
          outcome: "capability_degraded",
          method: pending.method,
          capability,
        });
      }
      if (pending.operationId && disposition === "indeterminate") {
        const record = this.mutations.get(pending.operationId);
        if (record) this.setMutation({ ...record, state: "indeterminate" });
      } else if (pending.operationId) {
        this.confirmMutation(pending.operationId);
      }
      this.logger?.({
        type: "response",
        method: pending.method,
        requestId,
        outcome: "rpc_error",
        errorCode: response.error.code,
      });
      pending.reject(new HermesGatewayRpcError(response.error.code, pending.method, disposition));
      return;
    }

    this.logger?.({
      type: "response",
      method: pending.method,
      requestId,
      outcome: "success",
    });
    pending.resolve(response.result);
  }

  private enqueueEvent(frame: HermesGatewayEventFrame): void {
    const transportSequence = ++this.transportSequence;
    const sessionId = frame.params.session_id || undefined;
    const sessionKey = sessionId ?? "";
    const sessionSequence = (this.sessionSequences.get(sessionKey) ?? 0) + 1;
    this.sessionSequences.set(sessionKey, sessionSequence);
    const ordered: HermesGatewayOrderedEvent = {
      transportSequence,
      sessionSequence,
      sessionId,
      eventId: frame.params.event_id,
      eventSequence: frame.params.event_sequence,
      emittedAt: frame.params.emitted_at,
      sessionKey: frame.params.session_key,
      runId: frame.params.run_id,
      messageId: frame.params.message_id,
      cursor: frame.params.event_sequence ?? frame.params.cursor,
      mutationId: frame.params.mutation_id,
      frame,
    };
    this.eventDispatch = this.eventDispatch
      .catch(() => undefined)
      .then(async () => {
        for (const listener of this.eventListeners) {
          try {
            await listener(ordered);
          } catch {
            // A failing observer must not block the remaining listeners.
          }
        }
      });
  }

  private sendRequest(
    method: string,
    params: HermesGatewayUnknownRecord,
    options: {
      readonly operation: "read" | "mutation";
      readonly operationId: string | undefined;
      readonly mutationId: string | undefined;
      readonly requiredCapability: string | undefined;
      readonly signal: AbortSignal | undefined;
      readonly retryOnReconnect: boolean;
      readonly timeoutMs: number;
    },
  ): Promise<unknown> {
    const ready = this.stateValue === "ready" && this.socket?.readyState === SOCKET_OPEN;
    const mayWaitForReconnect =
      options.operation === "read" &&
      options.retryOnReconnect &&
      this.stateValue === "reconnecting";
    if (!ready && !mayWaitForReconnect) {
      return Promise.reject(new HermesGatewayConnectionError("Hermes gateway is not ready."));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new HermesGatewayRequestCancelledError("Hermes request cancelled."));
    }

    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      let pending: PendingRequest;
      const abortListener =
        options.signal === undefined
          ? undefined
          : () => {
              const markIndeterminate = pending.operation === "mutation" && pending.sent;
              this.rejectPending(
                pending,
                markIndeterminate && pending.operationId
                  ? new HermesGatewayMutationIndeterminateError(pending.operationId, pending.method)
                  : new HermesGatewayRequestCancelledError("Hermes request cancelled."),
                markIndeterminate,
              );
            };
      pending = {
        id,
        method,
        params,
        operation: options.operation,
        operationId: options.operationId,
        mutationId: options.mutationId,
        requiredCapability: options.requiredCapability,
        retryOnReconnect: options.retryOnReconnect,
        resolve,
        reject,
        signal: options.signal,
        abortListener,
        timeout: undefined,
        sent: false,
        awaitingReconnect: false,
        timeoutMs: options.timeoutMs,
      };
      this.pending.set(id, pending);
      options.signal?.addEventListener("abort", abortListener!, { once: true });
      this.sendPending(pending);
    });
  }

  private sendPending(pending: PendingRequest): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      if (pending.operation === "read" && pending.retryOnReconnect) {
        pending.awaitingReconnect = true;
        return;
      }
      this.rejectPending(
        pending,
        new HermesGatewayConnectionError("Hermes gateway disconnected before send."),
        false,
      );
      return;
    }
    const frame = {
      jsonrpc: "2.0",
      id: pending.id,
      method: pending.method,
      params: pending.params,
    } as const;
    try {
      socket.send(JSON.stringify(frame));
      pending.sent = true;
      pending.awaitingReconnect = false;
      pending.timeout = setTimeout(() => {
        const markIndeterminate = pending.operation === "mutation";
        this.rejectPending(
          pending,
          markIndeterminate && pending.operationId
            ? new HermesGatewayMutationIndeterminateError(pending.operationId, pending.method)
            : new HermesGatewayConnectionError(`Hermes gateway read timed out: ${pending.method}`),
          markIndeterminate,
        );
      }, pending.timeoutMs);
      this.logger?.({
        type: "request",
        method: pending.method,
        requestId: pending.id,
        operation: pending.operation,
      });
    } catch {
      this.rejectPending(
        pending,
        new HermesGatewayConnectionError("Hermes gateway send failed before admission."),
        false,
      );
    }
  }

  private rejectPending(pending: PendingRequest, error: Error, markIndeterminate: boolean): void {
    if (!this.pending.delete(pending.id)) return;
    this.clearPendingResources(pending);
    if (markIndeterminate && pending.operationId) {
      const record = this.mutations.get(pending.operationId);
      if (record) {
        this.setMutation({ ...record, state: "indeterminate" });
      }
    }
    pending.reject(error);
  }

  private clearPendingResources(pending: PendingRequest): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.timeout = undefined;
    if (pending.abortListener) {
      pending.signal?.removeEventListener("abort", pending.abortListener);
    }
  }

  private handleClose(_event: HermesGatewaySocketEvent, generation: number): void {
    if (generation !== this.connectionGeneration) return;
    this.socket = undefined;
    this.rejectReady(new HermesGatewayConnectionError("Hermes gateway disconnected."));
    if (this.manuallyClosed || this.stateValue === "closed") return;
    this.handleConnectionFailure();
  }

  private handleConnectionFailure(): void {
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      this.clearPendingResources(pending);
      if (pending.operation === "read" && pending.retryOnReconnect) {
        pending.awaitingReconnect = true;
        pending.sent = false;
        continue;
      }
      this.rejectPending(
        pending,
        pending.operationId
          ? new HermesGatewayMutationIndeterminateError(pending.operationId, pending.method)
          : new HermesGatewayConnectionError("Hermes gateway disconnected."),
        pending.operation === "mutation" && pending.sent,
      );
    }

    const reconnecting = this.maxReconnectAttempts > 0;
    this.setState(reconnecting ? "reconnecting" : "disconnected", 0);
    void Promise.resolve()
      .then(() =>
        this.supervisor?.onDisconnected?.({
          reconnecting,
          pendingReads: [...this.pending.values()].filter(
            (pending) => pending.operation === "read" && pending.awaitingReconnect,
          ).length,
          indeterminateMutations: this.indeterminateOperationIds(),
        }),
      )
      .catch(() => undefined);
    if (reconnecting && !this.reconnectTask) {
      this.reconnectTask = this.reconnectLoop().finally(() => {
        this.reconnectTask = undefined;
      });
    } else if (!reconnecting) {
      this.rejectPendingReads(new HermesGatewayConnectionError("Hermes gateway disconnected."));
    }
  }

  private async reconnectLoop(): Promise<void> {
    let lastError: Error = new HermesGatewayConnectionError("Hermes gateway disconnected.");
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      await delay(
        Math.min(this.reconnectBaseDelayMs * 2 ** (attempt - 1), this.reconnectMaxDelayMs),
      );
      if (this.manuallyClosed) return;
      try {
        await this.connectAttempt(attempt, true);
        return;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new HermesGatewayConnectionError("Hermes gateway reconnect failed.");
      }
    }
    this.setState("disconnected", this.maxReconnectAttempts);
    this.rejectPendingReads(lastError);
    try {
      await this.supervisor?.onReconnectExhausted?.({
        attempts: this.maxReconnectAttempts,
      });
    } catch {
      // Supervisor failures must not become unhandled rejections.
    }
  }

  private replayPendingReads(): void {
    for (const pending of this.pending.values()) {
      if (pending.operation === "read" && pending.awaitingReconnect) {
        if (pending.requiredCapability && !this.capabilities.has(pending.requiredCapability)) {
          this.rejectPending(
            pending,
            new HermesGatewayCapabilityError(pending.requiredCapability),
            false,
          );
          continue;
        }
        this.sendPending(pending);
      }
    }
  }

  private rejectPendingReads(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.operation === "read") {
        this.rejectPending(pending, error, false);
      }
    }
  }

  private requireCapability(capability: string | undefined): void {
    if (capability && !this.capabilities.has(capability)) {
      throw new HermesGatewayCapabilityError(capability);
    }
  }

  private confirmMutation(operationId: string): void {
    const record = this.mutations.get(operationId);
    if (record) this.setMutation({ ...record, state: "confirmed" });
  }

  private markMutationIndeterminate(operationId: string): void {
    const record = this.mutations.get(operationId);
    if (record) this.setMutation({ ...record, state: "indeterminate" });
  }

  private setMutation(record: HermesGatewayMutationRecord): void {
    this.mutations.set(record.operationId, record);
    this.logger?.({
      type: "mutation",
      operationId: "<redacted-id>",
      method: record.method,
      state: record.state,
    });
    this.emitHealth();
  }

  private indeterminateOperationIds(): ReadonlyArray<string> {
    return [...this.mutations.values()]
      .filter((record) => record.state === "indeterminate")
      .map((record) => record.operationId)
      .toSorted();
  }

  private setState(state: HermesGatewayConnectionState, attempt: number): void {
    this.stateValue = state;
    this.reconnectAttempt = attempt;
    this.logger?.({
      type: "connection",
      state,
      endpoint: this.endpointLabel,
      attempt,
    });
    this.emitHealth();
  }

  private emitHealth(): void {
    const health = this.health;
    for (const listener of this.healthListeners) {
      try {
        listener(health);
      } catch {
        // A failing health listener must not block the remaining listeners.
      }
    }
  }
}

function authenticatedEndpoint(options: HermesGatewayClientOptions): string {
  const assessment = assessHermesConnectionSecurity({
    endpoint: options.endpoint,
    gatewayToken: options.authToken,
    remoteGloballyEnabled: false,
    remoteInstanceEnabled: false,
    remotePairingToken: undefined,
    remoteTlsCertificateSha256: undefined,
  });
  if (assessment.status !== "ready") {
    throw new HermesGatewayConfigurationError(assessment.message);
  }
  const endpoint = new URL(assessment.endpoint);
  endpoint.searchParams.set("token", assessment.authToken);
  return endpoint.toString();
}

function defaultSocketFactory(endpoint: string): HermesGatewaySocket {
  return new WebSocket(endpoint) as unknown as HermesGatewaySocket;
}

const compiledResultDecoders = new WeakMap<Schema.Top, (value: unknown) => unknown>();

function decodeResult<S extends Schema.Top>(
  schema: S,
  value: unknown,
  method: string,
): Schema.Schema.Type<S> {
  let decode = compiledResultDecoders.get(schema);
  if (decode === undefined) {
    decode = Schema.decodeUnknownSync(schema as never);
    compiledResultDecoders.set(schema, decode);
  }
  try {
    return decode(value) as Schema.Schema.Type<S>;
  } catch {
    throw new HermesGatewayProtocolError(`Hermes gateway returned malformed ${method} result.`);
  }
}

function decodeOptionalMutationOutcome(value: unknown): HermesGatewayMutationOutcome | undefined {
  try {
    return decodeMutationOutcome(value);
  } catch {
    return undefined;
  }
}

function capabilityEnabled(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") {
    return !["", "disabled", "unsupported", "unavailable", "false"].includes(
      value.trim().toLowerCase(),
    );
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const enabled = (value as Readonly<Record<string, unknown>>).enabled;
    return enabled !== false;
  }
  return true;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
