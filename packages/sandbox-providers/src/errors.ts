import { SandboxErrorCategory, SandboxProviderKind } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const SandboxProviderOperation = Schema.Literals([
  "create",
  "exec",
  "snapshot",
  "pauseOrStop",
  "resume",
  "getStatus",
  "destroy",
  "getPublicUrl",
]);
export type SandboxProviderOperation = typeof SandboxProviderOperation.Type;

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  provider: SandboxProviderKind,
  operation: SandboxProviderOperation,
  category: SandboxErrorCategory,
  sandboxId: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const target = this.sandboxId !== undefined ? ` (${this.sandboxId})` : "";
    const exit = this.exitCode !== undefined ? ` [exit ${this.exitCode}]` : "";
    return `Sandbox ${this.provider} ${this.operation}${target} failed: ${this.category}${exit}.`;
  }
}

const isSandboxError = Schema.is(SandboxError);

function extractHttpStatus(cause: unknown): number | undefined {
  if (!Predicate.isObject(cause)) return undefined;
  const candidate = cause as {
    readonly statusCode?: unknown;
    readonly status?: unknown;
    readonly response?: { readonly status?: unknown };
  };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.status === "number") return candidate.status;
  if (Predicate.isObject(candidate.response) && typeof candidate.response.status === "number") {
    return candidate.response.status;
  }
  return undefined;
}

function classifySandboxFailure(cause: unknown): SandboxErrorCategory {
  const status = extractHttpStatus(cause);
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (cause instanceof Error) {
    const name = cause.name.toLowerCase();
    const message = cause.message.toLowerCase();
    if (name.includes("abort") || message.includes("timeout") || message.includes("timed out")) {
      return "timeout";
    }
    if (message.includes("not found") || message.includes("does not exist")) {
      return "not_found";
    }
    if (
      message.includes("unauthorized") ||
      message.includes("forbidden") ||
      message.includes("invalid api key") ||
      message.includes("authentication")
    ) {
      return "auth";
    }
    if (message.includes("rate limit") || message.includes("too many requests")) {
      return "rate_limit";
    }
  }
  return "provider_error";
}

export function toSandboxError(input: {
  readonly provider: SandboxProviderKind;
  readonly operation: SandboxProviderOperation;
  readonly sandboxId?: string | undefined;
  readonly cause: unknown;
}): SandboxError {
  if (isSandboxError(input.cause)) return input.cause;
  return new SandboxError({
    provider: input.provider,
    operation: input.operation,
    category: classifySandboxFailure(input.cause),
    ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
    cause: input.cause,
  });
}
