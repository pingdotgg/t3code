import { type HermesSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as EffectAcpErrors from "effect-acp/errors";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const HERMES_AUTH_METHOD = "hermes-setup";

type HermesAcpSettings = Pick<HermesSettings, "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "concurrentPrompts" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  settings: HermesAcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD,
        concurrentPrompts: true,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export function resolveHermesModelId(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  return value && value !== "default" ? value : undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const modelId = resolveHermesModelId(input.model);
  return modelId
    ? input.runtime.setSessionModel(modelId).pipe(Effect.mapError(input.mapError))
    : Effect.void;
}

export const deleteHermesSession = Effect.fn("deleteHermesSession")(function* (input: {
  readonly settings: HermesAcpSettings;
  readonly sessionId: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const command = input.settings.binaryPath || "hermes";
  const spawnCommand = yield* resolveSpawnCommand(
    command,
    ["sessions", "delete", input.sessionId, "--yes"],
    input.environment ? { env: input.environment } : {},
  );
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(input.environment ? { env: input.environment } : {}),
      shell: spawnCommand.shell,
    }),
  );
});
