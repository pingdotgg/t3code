import { type AntigravitySettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY";
const ANTIGRAVITY_AUTH_METHOD_API_KEY = "gemini-api-key";
const ANTIGRAVITY_AUTH_METHOD_OAUTH = "oauth-personal";
const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");

type AntigravityAcpRuntimeSettings = Pick<AntigravitySettings, "binaryPath" | "geminiHome">;

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

export function buildAntigravityAcpSpawnInput(
  antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env: Record<string, string | undefined> = { ...environment };
  if (antigravitySettings?.geminiHome) {
    env.GEMINI_HOME = antigravitySettings.geminiHome;
  }
  return {
    command: antigravitySettings?.binaryPath || "antigravity-acp-server",
    args: [],
    cwd,
    env,
  };
}

function resolveAntigravityAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  const hasApiKey =
    environment?.[GEMINI_API_KEY_ENV]?.trim() || environment?.[GOOGLE_API_KEY_ENV]?.trim();
  return hasApiKey ? ANTIGRAVITY_AUTH_METHOD_API_KEY : ANTIGRAVITY_AUTH_METHOD_OAUTH;
}

export const makeAntigravityAcpRuntime = (
  input: AntigravityAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAntigravityAcpSpawnInput(
          input.antigravitySettings,
          input.cwd,
          input.environment,
        ),
        authMethodId: resolveAntigravityAuthMethodId(input.environment),
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

export function resolveAntigravityAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "gemini-3.7-flash";
  return normalizeModelSlug(base, ANTIGRAVITY_DRIVER_KIND) ?? "gemini-3.7-flash";
}

export function currentAntigravityModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyAntigravityAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
