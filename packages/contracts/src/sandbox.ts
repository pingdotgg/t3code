import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedString } from "./baseSchemas.ts";

/**
 * Sandbox providers are provisioned by the server a client is already connected to. The
 * provider's API key is saved in that server's settings, so an environment can be created from
 * any client without ever sending its key to the other machines on the account.
 */
export const SandboxProviderKind = Schema.Literals(["boat", "daytona"]);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

export const SandboxMachineSize = Schema.Struct({
  id: TrimmedString,
  label: TrimmedString,
  detail: TrimmedString,
});
export type SandboxMachineSize = typeof SandboxMachineSize.Type;

export const SandboxProviderInfo = Schema.Struct({
  kind: SandboxProviderKind,
  label: TrimmedString,
  detail: TrimmedString,
  apiKeyLabel: TrimmedString,
  apiKeyPlaceholder: TrimmedString,
  docsUrl: TrimmedString,
  /** False until an API key is saved on this server. */
  configured: Schema.Boolean,
  sizes: Schema.Array(SandboxMachineSize),
});
export type SandboxProviderInfo = typeof SandboxProviderInfo.Type;

export const SandboxProvidersResult = Schema.Struct({
  providers: Schema.Array(SandboxProviderInfo),
});
export type SandboxProvidersResult = typeof SandboxProvidersResult.Type;

/**
 * A provider-side environment is the only supported way to give a sandbox credentials. It
 * decides whether the provider passes its GitHub token, secrets, and agent logins; T3 never
 * reads or forwards those values itself.
 */
export const SandboxCredentialEnvironment = Schema.Struct({
  name: TrimmedString,
  isDefault: Schema.Boolean,
  safeForThirdParties: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  proxyAiCredentials: Schema.Boolean,
});
export type SandboxCredentialEnvironment = typeof SandboxCredentialEnvironment.Type;

export const SandboxCredentialEnvironmentsInput = Schema.Struct({
  provider: SandboxProviderKind,
});
export type SandboxCredentialEnvironmentsInput = typeof SandboxCredentialEnvironmentsInput.Type;

export const SandboxCredentialEnvironmentsResult = Schema.Struct({
  environments: Schema.Array(SandboxCredentialEnvironment),
});
export type SandboxCredentialEnvironmentsResult = typeof SandboxCredentialEnvironmentsResult.Type;

export const SandboxCreateInput = Schema.Struct({
  provider: SandboxProviderKind,
  /** Saved on this server when present; when omitted the saved key is used. */
  apiKey: Schema.optional(TrimmedString),
  /** Shown as the environment and sandbox name. Defaults to a generated name. */
  label: Schema.optional(TrimmedString),
  /** One of the provider's machine size ids. Defaults to the provider's default size. */
  size: Schema.optional(TrimmedString),
  /** Cloned into the sandbox before the environment is connected. */
  repositoryUrl: Schema.optional(TrimmedString),
  /** Provider environment whose credentials the sandbox receives. Omit for no credentials. */
  environment: Schema.optional(TrimmedString),
  /** Required with `environment`: the user confirmed that this environment passes credentials. */
  allowCredentials: Schema.optional(Schema.Boolean),
  /** Stop the machine after this many minutes. Omit to leave the provider default. */
  ttlMinutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 43200 }))),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

export const SandboxCreateResult = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  environmentId: EnvironmentId,
  label: TrimmedString,
  /** Public origin of the T3 server running in the sandbox. */
  httpBaseUrl: TrimmedString,
  /** One-time pairing code, consumed by the client that connects to the new environment. */
  pairingCode: TrimmedString,
});
export type SandboxCreateResult = typeof SandboxCreateResult.Type;

export const SandboxDeleteInput = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  environmentId: EnvironmentId,
});
export type SandboxDeleteInput = typeof SandboxDeleteInput.Type;

export const SandboxLifecycleState = Schema.Literals([
  "provisioning",
  "running",
  "stopped",
  "error",
  "deleted",
]);
export type SandboxLifecycleState = typeof SandboxLifecycleState.Type;

/** Server-side record that ties a provider machine to the T3 environment it became. */
export const SandboxRecord = Schema.Struct({
  environmentId: EnvironmentId,
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  label: TrimmedString,
  size: TrimmedString,
  state: SandboxLifecycleState,
  createdAt: TrimmedString,
  updatedAt: TrimmedString,
  httpBaseUrl: TrimmedString,
  /** Null disables the hard deadline. */
  hardDeadlineAt: Schema.NullOr(TrimmedString),
  ttlMinutes: Schema.Int,
  credentialEnvironment: Schema.optionalKey(TrimmedString),
});
export type SandboxRecord = typeof SandboxRecord.Type;

export const SandboxListResult = Schema.Struct({
  sandboxes: Schema.Array(SandboxRecord),
});
export type SandboxListResult = typeof SandboxListResult.Type;

export const SandboxLifecycleInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type SandboxLifecycleInput = typeof SandboxLifecycleInput.Type;

export const SandboxStopResult = Schema.Struct({
  sandbox: SandboxRecord,
});
export type SandboxStopResult = typeof SandboxStopResult.Type;

export const SandboxResumeResult = Schema.Struct({
  sandbox: SandboxRecord,
  httpBaseUrl: TrimmedString,
});
export type SandboxResumeResult = typeof SandboxResumeResult.Type;

export const SandboxStage = Schema.Literals([
  "create",
  "install",
  "start",
  "expose",
  "pair",
  "delete",
  "config",
]);
export type SandboxStage = typeof SandboxStage.Type;

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()(
  "SandboxProviderError",
  {
    provider: SandboxProviderKind,
    stage: SandboxStage,
    /**
     * Bounded, human-readable reason shown to the user. Never a raw provider response body or
     * remote command output: those can carry credentials.
     */
    detail: Schema.String,
    /** The provider's HTTP status when the failure came from a response. */
    status: Schema.optional(Schema.Number),
    /** The exact underlying error or output, kept out of `message` and out of logs. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider}: ${this.detail}`;
  }
}

export const SandboxSettings = Schema.Struct({
  apiKey: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
});
export type SandboxSettings = typeof SandboxSettings.Type;
