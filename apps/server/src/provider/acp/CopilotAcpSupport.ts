import { type CopilotSettings } from "@t3tools/contracts";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type CopilotAcpRuntimeCopilotSettings = Pick<CopilotSettings, "binaryPath" | "launchArgs">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const parsedLaunchArgs = parseCliArgs(copilotSettings?.launchArgs ?? "");
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: [
      ...parsedLaunchArgs.positionals,
      ...flagsToArgs(parsedLaunchArgs.flags),
      "--acp",
      "--stdio",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

function flagsToArgs(flags: Record<string, string | null>): ReadonlyArray<string> {
  return Object.entries(flags).flatMap(([key, value]) =>
    value === null ? [`--${key}`] : [`--${key}`, value],
  );
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input.copilotSettings, input.cwd, input.environment),
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

export function resolveCopilotAcpBaseModelId(model: string | null | undefined): string {
  return model?.trim() || "copilot";
}

export function applyCopilotAcpModelSelection(): Effect.Effect<void, never> {
  return Effect.void;
}
