import { type DevinSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";
const DEVIN_AUTH_METHOD_API_KEY = "windsurf-api-key";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");
const DEVIN_DEFAULT_MODEL_ID = "adaptive";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath" | "apiKey">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "authenticateMeta" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    env: { ...environment },
  };
}

/**
 * Devin's ACP server intentionally ignores local CLI credentials — the host
 * must supply an API key via `authenticate` `_meta.api_key`. We source the
 * key from instance settings first, then the `WINDSURF_API_KEY` environment
 * variable. When neither is present the plain authenticate call starts
 * Devin's PKCE browser login flow.
 */
export function hasDevinCredentials(
  devinSettings: Pick<DevinSettings, "apiKey"> | null | undefined,
  environment: NodeJS.ProcessEnv | undefined,
): boolean {
  return Boolean(devinSettings?.apiKey?.trim() || environment?.[DEVIN_API_KEY_ENV]?.trim());
}

function resolveDevinAuthenticateMeta(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  environment: NodeJS.ProcessEnv | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const apiKey = devinSettings?.apiKey?.trim() || environment?.[DEVIN_API_KEY_ENV]?.trim();
  return apiKey ? { api_key: apiKey } : undefined;
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    // Default to the server's environment so an omitted `environment` still
    // inherits PATH (binary resolution) and WINDSURF_API_KEY (credentials)
    // instead of spawning the child with an empty env.
    const environment = input.environment ?? process.env;
    const authenticateMeta = resolveDevinAuthenticateMeta(input.devinSettings, environment);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, environment),
        authMethodId: DEVIN_AUTH_METHOD_API_KEY,
        ...(authenticateMeta ? { authenticateMeta } : {}),
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

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL_ID;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? DEVIN_DEFAULT_MODEL_ID;
}

export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;

function isMethodNotFound(cause: EffectAcpErrors.AcpError): boolean {
  return cause._tag === "AcpRequestError" && cause.code === JSON_RPC_METHOD_NOT_FOUND;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // Devin's ACP server does not implement the unstable `session/set_model`
  // capability and reports no session model state — model routing happens
  // server-side (Adaptive). Only attempt a switch when the agent reported a
  // current model, i.e. it actually negotiated model support.
  const shouldSwitchModel =
    input.currentModelId !== undefined &&
    input.requestedModelId !== undefined &&
    input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime.setSessionModel(input.requestedModelId).pipe(
    Effect.as<string | undefined>(input.requestedModelId),
    Effect.catchIf(isMethodNotFound, () =>
      Effect.logDebug("Devin ACP does not support session/set_model; keeping agent default.").pipe(
        Effect.as(input.currentModelId),
      ),
    ),
    Effect.mapError(input.mapError),
  );
}
