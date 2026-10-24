import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderApprovalOption,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { CommandCodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeModelSlug } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

export const COMMAND_CODE_DRIVER_KIND = ProviderDriverKind.make("commandCode");
export const COMMAND_CODE_DEFAULT_MODEL_SLUG = "gpt-5.6-sol";

type CommandCodeAcpRuntimeSettings = Pick<CommandCodeSettings, "binaryPath">;

export interface CommandCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly commandCodeSettings: CommandCodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const COMMAND_CODE_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export function commandCodeAcpSpawnArgs(): ReadonlyArray<string> {
  return ["acp"];
}

export function buildCommandCodeAcpSpawnInput(
  settings: CommandCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "cmd",
    args: [...commandCodeAcpSpawnArgs()],
    cwd,
    env: {
      ...environment,
    },
  };
}

export function resolveCommandCodeAuthMethodId(): string {
  return "command-code-cli";
}

export function commandCodeApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"], optionId?: string) =>
    request.options.some(
      (option) =>
        option.kind === kind && (optionId === undefined || option.optionId.trim() === optionId),
    );
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Decline" } as const] : []),
    ...(has("allow_always")
      ? [{ decision: "acceptForSession", label: "Allow all during this session" } as const]
      : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Approve" } as const] : []),
  ];
}

export const makeCommandCodeAcpRuntime = Effect.fn(
  "CommandCodeAcpSupport.makeCommandCodeAcpRuntime",
)(function* (
  input: CommandCodeAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const processGroupPlatform = yield* HostProcess.Platform.pipe(Effect.provide(NodeServices.layer));
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildCommandCodeAcpSpawnInput(input.commandCodeSettings, input.cwd, input.environment),
      authMethodId: resolveCommandCodeAuthMethodId(),
      ownDescendantProcessGroups: processGroupPlatform === "linux",
      ownDetachedProcessGroup: true,
      processGroupPlatform,
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

export function resolveCommandCodeAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : COMMAND_CODE_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, COMMAND_CODE_DRIVER_KIND) ?? COMMAND_CODE_DEFAULT_MODEL_SLUG;
}
