import type { TailcatFailureCode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Failure kinds the runtime can name. Every error maps to a `TailcatFailureCode`
 * so UIs translate them into plain language without matching on message text,
 * and carries a `detail` safe for logs: tailcat output never contains private
 * keys, but it is still bounded and stripped of anything key-shaped first.
 */
const TailcatErrorFields = {
  detail: Schema.String,
};

export class TailcatBinaryMissingError extends Schema.TaggedErrorClass<TailcatBinaryMissingError>()(
  "TailcatBinaryMissingError",
  {
    ...TailcatErrorFields,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatBinaryNotExecutableError extends Schema.TaggedErrorClass<TailcatBinaryNotExecutableError>()(
  "TailcatBinaryNotExecutableError",
  {
    ...TailcatErrorFields,
    path: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatVersionIncompatibleError extends Schema.TaggedErrorClass<TailcatVersionIncompatibleError>()(
  "TailcatVersionIncompatibleError",
  {
    ...TailcatErrorFields,
    path: Schema.String,
    version: Schema.String,
    compatibleRange: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatCommandError extends Schema.TaggedErrorClass<TailcatCommandError>()(
  "TailcatCommandError",
  {
    ...TailcatErrorFields,
    subcommand: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatAddressInvalidError extends Schema.TaggedErrorClass<TailcatAddressInvalidError>()(
  "TailcatAddressInvalidError",
  {
    ...TailcatErrorFields,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatPortInUseError extends Schema.TaggedErrorClass<TailcatPortInUseError>()(
  "TailcatPortInUseError",
  {
    ...TailcatErrorFields,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatStartupError extends Schema.TaggedErrorClass<TailcatStartupError>()(
  "TailcatStartupError",
  {
    ...TailcatErrorFields,
    subcommand: Schema.Literals(["serve", "forward"]),
    exitCode: Schema.NullOr(Schema.Number),
    recentOutput: Schema.Array(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatTimeoutError extends Schema.TaggedErrorClass<TailcatTimeoutError>()(
  "TailcatTimeoutError",
  {
    ...TailcatErrorFields,
    subcommand: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TailcatProcessExitedError extends Schema.TaggedErrorClass<TailcatProcessExitedError>()(
  "TailcatProcessExitedError",
  {
    ...TailcatErrorFields,
    subcommand: Schema.Literals(["serve", "forward"]),
    exitCode: Schema.NullOr(Schema.Number),
    recentOutput: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const TailcatRuntimeError = Schema.Union([
  TailcatBinaryMissingError,
  TailcatBinaryNotExecutableError,
  TailcatVersionIncompatibleError,
  TailcatCommandError,
  TailcatAddressInvalidError,
  TailcatPortInUseError,
  TailcatStartupError,
  TailcatTimeoutError,
  TailcatProcessExitedError,
]);
export type TailcatRuntimeError = typeof TailcatRuntimeError.Type;
export const isTailcatRuntimeError = Schema.is(TailcatRuntimeError);

/** The contracts-level failure code for any runtime error, for UIs and state snapshots. */
export function tailcatFailureCode(error: TailcatRuntimeError): TailcatFailureCode {
  switch (error._tag) {
    case "TailcatBinaryMissingError":
      return "binary-missing";
    case "TailcatBinaryNotExecutableError":
      return "binary-not-executable";
    case "TailcatVersionIncompatibleError":
      return "version-incompatible";
    case "TailcatAddressInvalidError":
      return "address-invalid";
    case "TailcatPortInUseError":
      return "port-in-use";
    case "TailcatStartupError":
      return "startup-failed";
    case "TailcatTimeoutError":
      return "timeout";
    case "TailcatProcessExitedError":
      return "process-exited";
    case "TailcatCommandError":
      return "unknown";
  }
}

/**
 * Strips anything that looks like private key material from a line of tailcat
 * output. Tailcat does not print private keys, so this is defense in depth for
 * output that ends up in diagnostics.
 */
export function redactTailcatOutputLine(line: string): string {
  return line.replace(/privkey:[0-9a-f]+/giu, "privkey:<redacted>");
}
