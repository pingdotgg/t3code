import { type KiroSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

/**
 * Kiro can pause a turn to ask the user for a decision via `session/elicitation`.
 * Advertising the form capability lets Kiro use structured elicitation, which the
 * shared ACP adapter surfaces through T3 Code's user-input flow. `url` mode is
 * intentionally not advertised because the client cannot render URL elicitations.
 */
const KIRO_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

type KiroAcpRuntimeSettings = Pick<KiroSettings, "binaryPath">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Kiro authenticates through its CLI login or `KIRO_API_KEY`; unlike Cursor
 * and Grok, its ACP server does not expose the optional `authenticate` RPC.
 */
export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
        clientCapabilities: KIRO_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiroAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  // Keep the advertised "default" slug as a real model id so selecting it after
  // a custom model issues session/set_model instead of "do not switch" (undefined).
  if (!trimmed) {
    return undefined;
  }
  return normalizeModelSlug(trimmed, KIRO_DRIVER_KIND) ?? trimmed;
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
