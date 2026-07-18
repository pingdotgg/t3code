import { type KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIMI_AUTH_METHOD_LOGIN = "login";
const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

/**
 * Resolve the `kimi` executable, falling back to the CLI's well-known install
 * directory when it is not on `PATH`.
 *
 * An explicit `binaryPath` (anything other than the bare default `"kimi"`) is
 * authoritative and used verbatim. Otherwise we prefer a `PATH`-resolvable `kimi`,
 * and only if that is missing do we try `~/.kimi-code/bin/kimi[.exe]` — the Kimi
 * installer does NOT add `kimi` to `PATH` on Windows, so a Windows user with no
 * manual override would otherwise get a spurious "not installed". Threading the
 * resolved concrete path through means downstream spawns don't re-scan `PATH`.
 */
export const resolveKimiBinaryPath = Effect.fn("resolveKimiBinaryPath")(function* (
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  environment?: NodeJS.ProcessEnv,
) {
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

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const buildKimiAcpSpawnInput = Effect.fn("buildKimiAcpSpawnInput")(function* (
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) {
  const command = yield* resolveKimiBinaryPath(kimiSettings, environment);
  return {
    command,
    args: ["acp"],
    cwd,
    env: { ...environment },
  } satisfies AcpSessionRuntime.AcpSpawnInput;
});

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const spawn = yield* buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn,
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

export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "kimi-k3";
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? "kimi-k3";
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
