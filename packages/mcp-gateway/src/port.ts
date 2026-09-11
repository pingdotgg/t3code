import {
  GATEWAY_SCOPE_VALUES,
  hasGatewayScopes,
  parseGatewayStatusSnapshot,
} from "@t3tools/client-runtime/gateway";
import type {
  GatewayApprovalDecision,
  GatewayEnvironmentSummary,
  GatewayMutationResult,
  GatewayPage,
  GatewayProfile,
  GatewayRuntimeEvent,
  GatewayRuntimePort,
  GatewayScope,
  GatewayStatusSnapshot,
  GatewayThreadControlAction,
} from "@t3tools/client-runtime/gateway";

export { GATEWAY_SCOPE_VALUES, hasGatewayScopes, parseGatewayStatusSnapshot };
export type {
  GatewayApprovalDecision,
  GatewayEnvironmentSummary,
  GatewayMutationResult,
  GatewayPage,
  GatewayProfile,
  GatewayRuntimeEvent,
  GatewayRuntimePort,
  GatewayScope,
  GatewayStatusSnapshot,
  GatewayThreadControlAction,
};

export type GatewayErrorCode =
  | "invalid_input"
  | "unknown_tool"
  | "not_configured"
  | "unknown_environment"
  | "unknown_subscription"
  | "unknown_webhook"
  | "cursor_expired"
  | "idempotency_conflict"
  | "request_in_progress"
  | "stale_plan"
  | "destructive_confirmation_required"
  | "scope_required"
  | "environment_unavailable"
  | "upstream_failure";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly environmentId: string | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(input: {
    readonly code: GatewayErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly environmentId?: string;
    readonly requestId?: string;
    readonly details?: unknown;
  }) {
    super(input.message);
    this.name = "GatewayError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.environmentId = input.environmentId;
    this.requestId = input.requestId;
    this.details = input.details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.environmentId === undefined ? {} : { environmentId: this.environmentId }),
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
