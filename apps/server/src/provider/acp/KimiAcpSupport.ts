import { type KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";
// kimi-cli advertises a single terminal-auth method: `login`. The ACP
// `authenticate` call only validates the stored OAuth token; the actual
// device flow happens through `kimi login` (or T3's in-app sign-in, which
// writes the same credentials file).
const KIMI_AUTH_METHOD_LOGIN = "login";
const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath" | "homePath">;

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function resolveKimiHomePath(
  kimiSettings: Pick<KimiSettings, "homePath"> | null | undefined,
): string | undefined {
  const homePath = kimiSettings?.homePath?.trim();
  return homePath ? expandHomePath(homePath) : undefined;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const homePath = resolveKimiHomePath(kimiSettings);
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment || homePath
      ? {
          env: {
            ...environment,
            ...(homePath ? { [KIMI_CODE_HOME_ENV]: homePath } : {}),
          },
        }
      : {}),
  };
}

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: KIMI_AUTH_METHOD_LOGIN,
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

// kimi-code aliases its managed models as `kimi-code/<id>` in config.toml,
// and `session/set_model` only accepts those alias ids.
const KIMI_CODE_MODEL_NAMESPACE = "kimi-code/";

/**
 * Kimi model ids may carry a `kimi-code/` namespace prefix and a `,thinking`
 * variant suffix (e.g. `kimi-code/k3,thinking`). Selection and display always
 * use the base id; the thinking level is a separate session config option in
 * current kimi-cli builds.
 */
export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const withoutVariant = trimmed?.split(",", 1)[0]?.trim();
  const withoutNamespace = withoutVariant?.startsWith(KIMI_CODE_MODEL_NAMESPACE)
    ? withoutVariant.slice(KIMI_CODE_MODEL_NAMESPACE.length)
    : withoutVariant;
  const base = withoutNamespace && withoutNamespace.length > 0 ? withoutNamespace : "k3";
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? "k3";
}

/**
 * The ACP wire id for a base model id, resolved against the ids the agent
 * advertised at session setup when it did.
 *
 * kimi-cli (PyPI) advertises `availableModels` with bare ids (`k3`,
 * `k3,thinking`) and expects those on `session/set_model`. Kimi Code CLI
 * (~0.37) advertises no models at all and only accepts its config.toml alias
 * ids, which namespace managed models as `kimi-code/<id>`. Matching an
 * advertised id wins; with nothing advertised, bare ids get the `kimi-code/`
 * namespace; ids that already carry a namespace (custom models such as
 * `moonshot-ai/kimi-k3`) always pass through as-is.
 */
export function resolveKimiAcpWireModelId(
  baseModelId: string,
  advertisedModelIds?: ReadonlyArray<string> | undefined,
): string {
  if (advertisedModelIds && advertisedModelIds.length > 0) {
    const matches = advertisedModelIds.filter(
      (advertised) => resolveKimiAcpBaseModelId(advertised) === baseModelId,
    );
    // Prefer the plain id over its `,thinking` variant when both are advertised.
    const match = matches.find((advertised) => !advertised.includes(",")) ?? matches[0];
    if (match !== undefined) {
      return match;
    }
    // A custom model the agent did not advertise: trust the configured id.
    return baseModelId;
  }
  return baseModelId.includes("/") ? baseModelId : `${KIMI_CODE_MODEL_NAMESPACE}${baseModelId}`;
}

export function advertisedKimiModelIdsFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<string> | undefined {
  const models = sessionSetupResult.models?.availableModels;
  return models && models.length > 0 ? models.map((model) => model.modelId) : undefined;
}

export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly advertisedModelIds?: ReadonlyArray<string> | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const currentBaseModelId = input.currentModelId
    ? resolveKimiAcpBaseModelId(input.currentModelId)
    : undefined;
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== currentBaseModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(resolveKimiAcpWireModelId(input.requestedModelId, input.advertisedModelIds))
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** True when an ACP failure means "signed out", i.e. `authenticate` was rejected. */
export function isKimiAuthRequiredError(error: unknown): boolean {
  return isAcpRequestError(error) && (error.code === -32000 || error.method === "authenticate");
}
