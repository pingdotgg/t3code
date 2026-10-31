import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

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
  /** Stop the machine after this many minutes. Omit to leave the provider default. */
  ttlMinutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 43200 }))),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

export const SandboxCreateResult = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
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
});
export type SandboxDeleteInput = typeof SandboxDeleteInput.Type;

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
    detail: Schema.String,
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
