import type {
  GatewayEnvironmentSummary,
  GatewayMutationResult,
  GatewayPage,
  GatewayProfile,
  GatewayRuntimePort,
  GatewayScope,
} from "@t3tools/client-runtime/gateway";

export type {
  GatewayEnvironmentSummary,
  GatewayMutationResult,
  GatewayPage,
  GatewayProfile,
  GatewayRuntimePort,
  GatewayScope,
};

export type GatewayErrorCode =
  | "invalid_input"
  | "unknown_tool"
  | "invalid_profile"
  | "unknown_environment"
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
