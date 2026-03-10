import * as Data from "effect/Data";

export class CodexSessionNotFoundError extends Data.TaggedError("CodexSessionNotFoundError")<{
  readonly message: string;
  readonly sessionId: string;
}> {}

export class CodexDeviceAuthNotFoundError extends Data.TaggedError("CodexDeviceAuthNotFoundError")<{
  readonly message: string;
  readonly loginId: string;
}> {}

export class CodexCommandError extends Data.TaggedError("CodexCommandError")<{
  readonly message: string;
  readonly sandboxId: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export class CodexProtocolError extends Data.TaggedError("CodexProtocolError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly cause?: unknown;
}> {}

export class CodexRequestTimeoutError extends Data.TaggedError("CodexRequestTimeoutError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly method: string;
}> {}

export class CodexResponseError extends Data.TaggedError("CodexResponseError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly method: string;
  readonly code?: number;
  readonly cause?: unknown;
}> {}

export class CodexDeviceAuthParseError extends Data.TaggedError("CodexDeviceAuthParseError")<{
  readonly message: string;
  readonly loginId: string;
}> {}

export class CodexWaitForLoginError extends Data.TaggedError("CodexWaitForLoginError")<{
  readonly message: string;
  readonly loginId: string;
  readonly cause?: unknown;
}> {}

export class CodexWaitForTurnError extends Data.TaggedError("CodexWaitForTurnError")<{
  readonly message: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly cause?: unknown;
}> {}

export type StartCodexSessionError =
  | CodexCommandError
  | CodexProtocolError
  | CodexRequestTimeoutError
  | CodexResponseError;

export type StartDeviceAuthError = CodexCommandError | CodexDeviceAuthParseError;

export type ReadCodexSessionError =
  | CodexSessionNotFoundError
  | CodexProtocolError
  | CodexRequestTimeoutError
  | CodexResponseError;

export type OpenCodexThreadError = ReadCodexSessionError;

export type SendCodexTurnError = ReadCodexSessionError | CodexWaitForTurnError;

export type WaitForCodexTurnError = CodexSessionNotFoundError | CodexWaitForTurnError;
