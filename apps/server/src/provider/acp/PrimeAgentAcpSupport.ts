import { type ModelSelection, type PrimeAgentSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type PrimeAgentAcpSettings = Pick<PrimeAgentSettings, "binaryPath">;

export interface PrimeAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly primeAgentSettings: PrimeAgentAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly modelSelection?: Pick<ModelSelection, "model" | "options">;
  readonly sessionDir: string;
  readonly continueSession: boolean;
}

export function resolvePrimeAgentModel(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed !== "default" ? trimmed : undefined;
}

export function buildPrimeAgentAcpSpawnInput(input: {
  readonly settings: PrimeAgentAcpSettings | null | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly modelSelection?: Pick<ModelSelection, "model" | "options">;
  readonly sessionDir: string;
  readonly continueSession: boolean;
}): AcpSessionRuntime.AcpSpawnInput {
  const model = resolvePrimeAgentModel(input.modelSelection?.model);
  const thinking = getProviderOptionStringSelectionValue(input.modelSelection?.options, "thinking");
  return {
    command: input.settings?.binaryPath || "prime-agent",
    args: [
      "--mode",
      "acp",
      "--offline",
      "--cwd",
      input.cwd,
      "--session-dir",
      input.sessionDir,
      ...(input.continueSession ? ["--continue"] : []),
      ...(model ? ["--model", model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
    ],
    cwd: input.cwd,
    ...(input.environment ? { env: input.environment } : {}),
  };
}

export const makePrimeAgentAcpRuntime = (
  input: PrimeAgentAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPrimeAgentAcpSpawnInput({
          settings: input.primeAgentSettings,
          cwd: input.cwd,
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          sessionDir: input.sessionDir,
          continueSession: input.continueSession,
        }),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
