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

const SshCommandErrorFields = {
  command: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  stdout: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
};

const SshCommandFailureFields = {
  ...SshCommandErrorFields,
  cause: Schema.Defect(),
};

export class SshAuthenticationHelperError extends Schema.TaggedErrorClass<SshAuthenticationHelperError>()(
  "SshAuthenticationHelperError",
  {
    ...SshCommandFailureFields,
  },
) {
  override get message(): string {
    return "Failed to prepare SSH authentication helpers.";
  }
}

export class SshCommandSpawnError extends Schema.TaggedErrorClass<SshCommandSpawnError>()(
  "SshCommandSpawnError",
  {
    ...SshCommandFailureFields,
  },
) {
  override get message(): string {
    return causeMessage(this.cause, `Failed to spawn SSH command${targetSuffix(this.target)}.`);
  }
}

export class SshCommandExecutionError extends Schema.TaggedErrorClass<SshCommandExecutionError>()(
  "SshCommandExecutionError",
  {
    ...SshCommandFailureFields,
  },
) {
  override get message(): string {
    return causeMessage(this.cause, `Failed to run SSH command${targetSuffix(this.target)}.`);
  }
}

export class SshCommandExitError extends Schema.TaggedErrorClass<SshCommandExitError>()(
  "SshCommandExitError",
  {
    ...SshCommandErrorFields,
  },
) {
  override get message(): string {
    return (
      this.stderr.trim() ||
      this.stdout?.trim() ||
      `SSH command failed${targetSuffix(this.target)}${exitCodeSuffix(this.exitCode)}.`
    );
  }
}

export class SshCommandTimeoutError extends Schema.TaggedErrorClass<SshCommandTimeoutError>()(
  "SshCommandTimeoutError",
  {
    ...SshCommandErrorFields,
  },
) {
  override get message(): string {
    return `SSH command timed out after ${this.timeoutMs ?? 0}ms.`;
  }
}

export class SshCommandCancelledError extends Schema.TaggedErrorClass<SshCommandCancelledError>()(
  "SshCommandCancelledError",
  {
    ...SshCommandErrorFields,
  },
) {
  override get message(): string {
    return `SSH environment connection was cancelled${targetSuffix(this.target)}.`;
  }
}

export class SshTunnelSpawnError extends Schema.TaggedErrorClass<SshTunnelSpawnError>()(
  "SshTunnelSpawnError",
  {
    ...SshCommandFailureFields,
  },
) {
  override get message(): string {
    return causeMessage(this.cause, `Failed to spawn SSH tunnel${targetSuffix(this.target)}.`);
  }
}

export class SshTunnelMonitorError extends Schema.TaggedErrorClass<SshTunnelMonitorError>()(
  "SshTunnelMonitorError",
  {
    ...SshCommandFailureFields,
  },
) {
  override get message(): string {
    return causeMessage(this.cause, `Failed to monitor SSH tunnel${targetSuffix(this.target)}.`);
  }
}

export class SshTunnelExitError extends Schema.TaggedErrorClass<SshTunnelExitError>()(
  "SshTunnelExitError",
  {
    ...SshCommandErrorFields,
  },
) {
  override get message(): string {
    return (
      this.stderr.trim() ||
      this.stdout?.trim() ||
      `SSH tunnel exited unexpectedly${targetSuffix(this.target)}${exitCodeSuffix(this.exitCode)}.`
    );
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
    stdout: Schema.String,
  },
) {
  override get message(): string {
    return "SSH launch did not return a remote port.";
  }
}

export class SshLaunchOutputParseError extends Schema.TaggedErrorClass<SshLaunchOutputParseError>()(
  "SshLaunchOutputParseError",
  {
    stdout: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "SSH launch returned unparseable output.";
  }
}

export class SshLaunchInvalidPortError extends Schema.TaggedErrorClass<SshLaunchInvalidPortError>()(
  "SshLaunchInvalidPortError",
  {
    stdout: Schema.String,
    remotePort: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `SSH launch returned an invalid remote port: ${String(this.remotePort)}.`;
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
    stdout: Schema.String,
  },
) {
  override get message(): string {
    return "SSH pairing did not return a credential.";
  }
}

export class SshPairingOutputParseError extends Schema.TaggedErrorClass<SshPairingOutputParseError>()(
  "SshPairingOutputParseError",
  {
    stdout: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "SSH pairing returned unparseable output.";
  }
}

export class SshPairingInvalidCredentialError extends Schema.TaggedErrorClass<SshPairingInvalidCredentialError>()(
  "SshPairingInvalidCredentialError",
  {
    stdout: Schema.String,
  },
) {
  override get message(): string {
    return "SSH pairing command returned an invalid credential.";
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
    return causeMessage(this.cause, "Invalid SSH forwarded http base URL.");
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

export class SshReadinessProbeError extends Schema.TaggedErrorClass<SshReadinessProbeError>()(
  "SshReadinessProbeError",
  {
    requestUrl: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Backend readiness probe failed at ${this.requestUrl}.`;
  }
}

export class SshReadinessProbeTimeoutError extends Schema.TaggedErrorClass<SshReadinessProbeTimeoutError>()(
  "SshReadinessProbeTimeoutError",
  {
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
    attempt: Schema.Number,
  },
) {
  override get message(): string {
    return `Backend readiness probe exceeded ${this.timeoutMs}ms at ${this.requestUrl}.`;
  }
}

export class SshReadinessTimeoutError extends Schema.TaggedErrorClass<SshReadinessTimeoutError>()(
  "SshReadinessTimeoutError",
  {
    baseUrl: Schema.String,
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
    attempts: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Timed out waiting ${this.timeoutMs}ms for backend readiness at ${this.baseUrl}.`;
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

function targetSuffix(target: string | undefined): string {
  return target ? ` for ${target}` : "";
}

function causeMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function exitCodeSuffix(exitCode: number | null): string {
  return exitCode === null ? "" : ` (exit ${exitCode})`;
}
