import * as Schema from "effect/Schema";

export class SshHostDiscoveryError extends Schema.TaggedErrorClass<SshHostDiscoveryError>()(
  "SshHostDiscoveryError",
  {
    homeDir: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to discover SSH hosts.";
  }
}

export class SshHostAliasRequiredError extends Schema.TaggedErrorClass<SshHostAliasRequiredError>()(
  "SshHostAliasRequiredError",
  {
    alias: Schema.String,
  },
) {
  override get message(): string {
    return "SSH host alias is required.";
  }
}

export class SshTargetDestinationMissingError extends Schema.TaggedErrorClass<SshTargetDestinationMissingError>()(
  "SshTargetDestinationMissingError",
  {
    alias: Schema.String,
    hostname: Schema.String,
  },
) {
  override get message(): string {
    return "SSH target is missing its alias/hostname.";
  }
}

export const SshInvalidTargetError = Schema.Union([
  SshHostAliasRequiredError,
  SshTargetDestinationMissingError,
]);
export type SshInvalidTargetError = typeof SshInvalidTargetError.Type;

const SshCommandContextFields = {
  command: Schema.String,
  argumentCount: Schema.Number,
  target: Schema.String,
};

const SshCommandCauseFields = {
  ...SshCommandContextFields,
  cause: Schema.Defect(),
};

export const SshProcessExitReason = Schema.Literals(["authentication-failed", "process-exited"]);
export type SshProcessExitReason = typeof SshProcessExitReason.Type;

export class SshAuthenticationHelperError extends Schema.TaggedErrorClass<SshAuthenticationHelperError>()(
  "SshAuthenticationHelperError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare SSH authentication helpers for ${this.target}.`;
  }
}

export class SshCommandSpawnError extends Schema.TaggedErrorClass<SshCommandSpawnError>()(
  "SshCommandSpawnError",
  {
    ...SshCommandCauseFields,
  },
) {
  override get message(): string {
    return `Failed to spawn SSH command for ${this.target}.`;
  }
}

export class SshCommandExecutionError extends Schema.TaggedErrorClass<SshCommandExecutionError>()(
  "SshCommandExecutionError",
  {
    ...SshCommandCauseFields,
  },
) {
  override get message(): string {
    return `Failed to run SSH command for ${this.target}.`;
  }
}

export class SshCommandExitError extends Schema.TaggedErrorClass<SshCommandExitError>()(
  "SshCommandExitError",
  {
    ...SshCommandContextFields,
    exitCode: Schema.Number,
    stdoutBytes: Schema.Number,
    stderrBytes: Schema.Number,
    reason: SshProcessExitReason,
  },
) {
  override get message(): string {
    return `SSH command failed for ${this.target} (exit ${this.exitCode}).`;
  }
}

export class SshCommandTimeoutError extends Schema.TaggedErrorClass<SshCommandTimeoutError>()(
  "SshCommandTimeoutError",
  {
    ...SshCommandContextFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `SSH command timed out after ${this.timeoutMs}ms for ${this.target}.`;
  }
}

export class SshCommandCancelledError extends Schema.TaggedErrorClass<SshCommandCancelledError>()(
  "SshCommandCancelledError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `SSH environment connection was cancelled for ${this.target}.`;
  }
}

export class SshTunnelSpawnError extends Schema.TaggedErrorClass<SshTunnelSpawnError>()(
  "SshTunnelSpawnError",
  {
    ...SshCommandCauseFields,
  },
) {
  override get message(): string {
    return `Failed to spawn SSH tunnel for ${this.target}.`;
  }
}

export class SshTunnelMonitorError extends Schema.TaggedErrorClass<SshTunnelMonitorError>()(
  "SshTunnelMonitorError",
  {
    ...SshCommandCauseFields,
  },
) {
  override get message(): string {
    return `Failed to monitor SSH tunnel for ${this.target}.`;
  }
}

export class SshTunnelExitError extends Schema.TaggedErrorClass<SshTunnelExitError>()(
  "SshTunnelExitError",
  {
    ...SshCommandContextFields,
    exitCode: Schema.Number,
    stderrBytes: Schema.Number,
    reason: SshProcessExitReason,
  },
) {
  override get message(): string {
    return `SSH tunnel exited unexpectedly for ${this.target} (exit ${this.exitCode}).`;
  }
}

export const SshCommandError = Schema.Union([
  SshAuthenticationHelperError,
  SshCommandSpawnError,
  SshCommandExecutionError,
  SshCommandExitError,
  SshCommandTimeoutError,
  SshCommandCancelledError,
  SshTunnelSpawnError,
  SshTunnelMonitorError,
  SshTunnelExitError,
]);
export type SshCommandError = typeof SshCommandError.Type;

export class SshLaunchPortMissingError extends Schema.TaggedErrorClass<SshLaunchPortMissingError>()(
  "SshLaunchPortMissingError",
  {
    target: Schema.String,
    stdoutBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `SSH launch for ${this.target} did not return a remote port.`;
  }
}

export class SshLaunchOutputParseError extends Schema.TaggedErrorClass<SshLaunchOutputParseError>()(
  "SshLaunchOutputParseError",
  {
    target: Schema.String,
    stdoutBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `SSH launch for ${this.target} returned unparseable output.`;
  }
}

export class SshLaunchInvalidPortError extends Schema.TaggedErrorClass<SshLaunchInvalidPortError>()(
  "SshLaunchInvalidPortError",
  {
    target: Schema.String,
    stdoutBytes: Schema.Number,
    remotePort: Schema.Number,
  },
) {
  override get message(): string {
    return `SSH launch for ${this.target} returned an invalid remote port: ${this.remotePort}.`;
  }
}

export const SshLaunchError = Schema.Union([
  SshLaunchPortMissingError,
  SshLaunchOutputParseError,
  SshLaunchInvalidPortError,
]);
export type SshLaunchError = typeof SshLaunchError.Type;

export class SshPairingCredentialMissingError extends Schema.TaggedErrorClass<SshPairingCredentialMissingError>()(
  "SshPairingCredentialMissingError",
  {
    target: Schema.String,
    stdoutBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `SSH pairing for ${this.target} did not return a credential.`;
  }
}

export class SshPairingOutputParseError extends Schema.TaggedErrorClass<SshPairingOutputParseError>()(
  "SshPairingOutputParseError",
  {
    target: Schema.String,
    stdoutBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `SSH pairing for ${this.target} returned unparseable output.`;
  }
}

export class SshPairingInvalidCredentialError extends Schema.TaggedErrorClass<SshPairingInvalidCredentialError>()(
  "SshPairingInvalidCredentialError",
  {
    target: Schema.String,
    stdoutBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `SSH pairing for ${this.target} returned an invalid credential.`;
  }
}

export const SshPairingError = Schema.Union([
  SshPairingCredentialMissingError,
  SshPairingOutputParseError,
  SshPairingInvalidCredentialError,
]);
export type SshPairingError = typeof SshPairingError.Type;

export class SshHttpBridgeMissingUrlError extends Schema.TaggedErrorClass<SshHttpBridgeMissingUrlError>()(
  "SshHttpBridgeMissingUrlError",
  {},
) {
  override get message(): string {
    return "Invalid SSH forwarded http base URL.";
  }
}

export class SshHttpBridgeInvalidUrlError extends Schema.TaggedErrorClass<SshHttpBridgeInvalidUrlError>()(
  "SshHttpBridgeInvalidUrlError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid SSH forwarded http base URL.";
  }
}

export class SshHttpBridgeNonLoopbackUrlError extends Schema.TaggedErrorClass<SshHttpBridgeNonLoopbackUrlError>()(
  "SshHttpBridgeNonLoopbackUrlError",
  {
    hostname: Schema.String,
  },
) {
  override get message(): string {
    return "SSH desktop bridge only supports loopback forwarded URLs.";
  }
}

export const SshHttpBridgeError = Schema.Union([
  SshHttpBridgeMissingUrlError,
  SshHttpBridgeInvalidUrlError,
  SshHttpBridgeNonLoopbackUrlError,
]);
export type SshHttpBridgeError = typeof SshHttpBridgeError.Type;

const SshReadinessUrlDiagnostics = Schema.Struct({
  protocol: Schema.String,
  hostname: Schema.String,
  port: Schema.optional(Schema.String),
  urlLength: Schema.Number,
  pathnameLength: Schema.Number,
  hasQuery: Schema.Boolean,
  hasFragment: Schema.Boolean,
});

type SshReadinessUrlDiagnostics = typeof SshReadinessUrlDiagnostics.Type;

function readinessTarget(diagnostics: SshReadinessUrlDiagnostics): string {
  const port = diagnostics.port === undefined ? "" : `:${diagnostics.port}`;
  return `${diagnostics.protocol}//${diagnostics.hostname}${port}`;
}

export class SshReadinessProbeError extends Schema.TaggedErrorClass<SshReadinessProbeError>()(
  "SshReadinessProbeError",
  {
    request: SshReadinessUrlDiagnostics,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Backend readiness probe failed at ${readinessTarget(this.request)}.`;
  }
}

export class SshReadinessProbeTimeoutError extends Schema.TaggedErrorClass<SshReadinessProbeTimeoutError>()(
  "SshReadinessProbeTimeoutError",
  {
    request: SshReadinessUrlDiagnostics,
    timeoutMs: Schema.Number,
    attempt: Schema.Number,
  },
) {
  override get message(): string {
    return `Backend readiness probe exceeded ${this.timeoutMs}ms at ${readinessTarget(this.request)}.`;
  }
}

export class SshReadinessTimeoutError extends Schema.TaggedErrorClass<SshReadinessTimeoutError>()(
  "SshReadinessTimeoutError",
  {
    base: SshReadinessUrlDiagnostics,
    request: SshReadinessUrlDiagnostics,
    timeoutMs: Schema.Number,
    attempts: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Timed out waiting ${this.timeoutMs}ms for backend readiness at ${readinessTarget(this.base)}.`;
  }
}

export const SshReadinessError = Schema.Union([
  SshReadinessProbeError,
  SshReadinessProbeTimeoutError,
  SshReadinessTimeoutError,
]);
export type SshReadinessError = typeof SshReadinessError.Type;

export class SshPasswordPromptUnavailableError extends Schema.TaggedErrorClass<SshPasswordPromptUnavailableError>()(
  "SshPasswordPromptUnavailableError",
  {
    destination: Schema.String,
  },
) {
  override get message(): string {
    return `SSH authentication failed for ${this.destination}.`;
  }
}

export class SshPasswordPromptCancelledError extends Schema.TaggedErrorClass<SshPasswordPromptCancelledError>()(
  "SshPasswordPromptCancelledError",
  {
    destination: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `SSH authentication cancelled for ${this.destination}.`;
  }
}

export class SshPasswordPromptSecureRandomnessError extends Schema.TaggedErrorClass<SshPasswordPromptSecureRandomnessError>()(
  "SshPasswordPromptSecureRandomnessError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Secure randomness is unavailable.";
  }
}

export class SshPasswordPromptWindowUnavailableError extends Schema.TaggedErrorClass<SshPasswordPromptWindowUnavailableError>()(
  "SshPasswordPromptWindowUnavailableError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "T3 Code window is not available for SSH authentication.";
  }
}

export class SshPasswordPromptTimedOutError extends Schema.TaggedErrorClass<SshPasswordPromptTimedOutError>()(
  "SshPasswordPromptTimedOutError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `SSH authentication timed out for ${this.destination}.`;
  }
}

export class SshPasswordPromptWindowClosedError extends Schema.TaggedErrorClass<SshPasswordPromptWindowClosedError>()(
  "SshPasswordPromptWindowClosedError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "SSH authentication was cancelled because the app window closed.";
  }
}

export class SshPasswordPromptServiceStoppedError extends Schema.TaggedErrorClass<SshPasswordPromptServiceStoppedError>()(
  "SshPasswordPromptServiceStoppedError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "SSH password prompt service stopped.";
  }
}

export class SshPasswordPromptRequestError extends Schema.TaggedErrorClass<SshPasswordPromptRequestError>()(
  "SshPasswordPromptRequestError",
  {
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `SSH authentication failed for ${this.destination}.`;
  }
}

export const SshPasswordPromptError = Schema.Union([
  SshPasswordPromptUnavailableError,
  SshPasswordPromptCancelledError,
  SshPasswordPromptSecureRandomnessError,
  SshPasswordPromptWindowUnavailableError,
  SshPasswordPromptTimedOutError,
  SshPasswordPromptWindowClosedError,
  SshPasswordPromptServiceStoppedError,
  SshPasswordPromptRequestError,
]);
export type SshPasswordPromptError = typeof SshPasswordPromptError.Type;
