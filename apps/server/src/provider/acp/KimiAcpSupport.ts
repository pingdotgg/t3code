import * as NodeOS from "node:os";

import {
  type KimiSettings,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const KIMI_AUTH_METHOD_ID = "login";
const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";
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

export const resolveKimiBinaryPath = Effect.fn("resolveKimiBinaryPath")(function* (
  kimiSettings: Pick<KimiSettings, "binaryPath"> | null | undefined,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const configured = kimiSettings?.binaryPath?.trim();
  if (configured && configured !== "kimi") {
    return configured;
  }

  const command = configured || "kimi";
  if (yield* isCommandAvailable(command, environment ? { env: environment } : {})) {
    return command;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const wellKnownPath = path.join(
    NodeOS.homedir(),
    ".kimi-code",
    "bin",
    platform === "win32" ? "kimi.exe" : "kimi",
  );
  const exists = yield* fileSystem.exists(wellKnownPath).pipe(Effect.orElseSucceed(() => false));
  return exists ? wellKnownPath : command;
});

export const buildKimiAcpSpawnInput = Effect.fn("buildKimiAcpSpawnInput")(function* (
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<AcpSessionRuntime.AcpSpawnInput, never, FileSystem.FileSystem | Path.Path> {
  const homePath = kimiSettings?.homePath?.trim();
  const path = yield* Path.Path;
  const env =
    homePath || environment
      ? {
          ...environment,
          ...(homePath ? { [KIMI_CODE_HOME_ENV]: path.resolve(expandHomePath(homePath)) } : {}),
        }
      : undefined;

  return {
    command: yield* resolveKimiBinaryPath(kimiSettings, environment),
    args: ["acp"],
    cwd,
    ...(env ? { env } : {}),
  };
});

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawn = yield* buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn,
        authMethodId: KIMI_AUTH_METHOD_ID,
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

export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "kimi-for-coding";
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? "kimi-for-coding";
}

export function findKimiModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }> | undefined {
  return configOptions?.find(
    (option): option is Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }> =>
      option.type === "select" &&
      option.id.trim().toLowerCase() === "model" &&
      option.category?.trim().toLowerCase() === "model",
  );
}

export interface KimiAcpModelOption {
  readonly value: string;
  readonly name: string;
}

export function getKimiAcpModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<KimiAcpModelOption> {
  const modelOption = findKimiModelConfigOption(configOptions);
  if (!modelOption) {
    return [];
  }
  return modelOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((option) => ({
          value: option.value.trim(),
          name: option.name.trim(),
        })),
  );
}

export const KIMI_AUTH_REQUIRED_MESSAGE =
  "Kimi Code is not authenticated. Run kimi login and try again.";

/**
 * A logged-out Kimi CLI still creates sessions, but reports the "model"
 * select with an empty option list. Detect that state so callers can fail
 * with an authentication message instead of letting a model switch bounce
 * off client-side config validation with an opaque "expected one of" error.
 */
export function isKimiModelCatalogEmpty(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): boolean {
  const modelOption = findKimiModelConfigOption(configOptions);
  return modelOption !== undefined && getKimiAcpModelOptions(configOptions).length === 0;
}

export function makeKimiAuthRequiredError(): EffectAcpErrors.AcpRequestError {
  return new EffectAcpErrors.AcpRequestError({
    code: -32000,
    errorMessage: KIMI_AUTH_REQUIRED_MESSAGE,
    data: { reason: "auth_required" },
  });
}

export function currentKimiModelIdFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  return findKimiModelConfigOption(configOptions)?.currentValue?.trim() || undefined;
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
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
    .setConfigOption("model", input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

export function resolveKimiAcpModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): "default" | "plan" | "yolo" {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  return input.runtimeMode === "full-access" ? "yolo" : "default";
}

export function applyKimiAcpModeSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return input.runtime
    .setConfigOption("mode", resolveKimiAcpModeId(input))
    .pipe(Effect.mapError(input.mapError), Effect.asVoid);
}
