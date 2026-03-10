import * as Data from "effect/Data";

export class SandboxCreationError extends Data.TaggedError("SandboxCreationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SandboxLookupError extends Data.TaggedError("SandboxLookupError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class PtyCreationError extends Data.TaggedError("PtyCreationError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cause: unknown;
}> {}

export class PtyConnectionError extends Data.TaggedError("PtyConnectionError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

export class PtyInputError extends Data.TaggedError("PtyInputError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

export class PtyResizeError extends Data.TaggedError("PtyResizeError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly cause: unknown;
}> {}

export class PtyWaitError extends Data.TaggedError("PtyWaitError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

export class TerminalCleanupError extends Data.TaggedError("TerminalCleanupError")<{
  readonly message: string;
}> {}

export class TerminalStartupCleanupError extends Data.TaggedError("TerminalStartupCleanupError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type StartPlaygroundSessionError =
  | SandboxCreationError
  | PtyCreationError
  | PtyConnectionError
  | TerminalStartupCleanupError;

export type OpenSandboxPtySessionError =
  | SandboxLookupError
  | PtyCreationError
  | PtyConnectionError
  | TerminalStartupCleanupError;
