import {
  type OmpSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { findSessionConfigOption } from "./AcpRuntimeModel.ts";

type AcpSpawnInput = AcpSessionRuntime.AcpSpawnInput;
type AcpSessionRuntimeShape = AcpSessionRuntime.AcpSessionRuntime["Service"];

type OmpAcpRuntimeSettings = Pick<OmpSettings, "binaryPath" | "profile">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Text-generation and other non-session callers default to full access so
   * a headless OMP child cannot deadlock on an unhandled approval request.
   */
  readonly runtimeMode?: RuntimeMode;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

function approvalModeArgs(runtimeMode: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--approval-mode", "always-ask"];
    case "auto-accept-edits":
    case "auto":
      // OMP has no AI-review approval mode; "auto" degrades to auto-accept
      // edits while still surfacing execution approvals to the user.
      return ["--approval-mode", "write"];
    case "full-access":
      return ["--approval-mode", "yolo"];
  }
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings | null | undefined,
  cwd: string,
  runtimeMode: RuntimeMode = "full-access",
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const profile = ompSettings?.profile?.trim();
  return {
    command: ompSettings?.binaryPath || "omp",
    args: ["acp", ...(profile ? ["--profile", profile] : []), ...approvalModeArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(
          input.ompSettings,
          input.cwd,
          input.runtimeMode ?? "full-access",
          input.environment,
        ),
        authMethodId: "agent",
        clientCapabilities: {
          elicitation: { form: {} },
        },
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

interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

/**
 * Apply OMP's exact ACP model id, then replay provider-option selections that
 * still exist for that model. OMP refreshes `configOptions` after a model
 * switch, so stale options from a previous model are safely ignored.
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model) {
      yield* input.runtime.setModel(model).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    const configOptions = yield* input.runtime.getConfigOptions;
    for (const selection of input.selections ?? []) {
      const option = findSessionConfigOption(configOptions, selection.id);
      if (!option || option.category === "model" || option.category === "mode") {
        continue;
      }
      yield* input.runtime.setConfigOption(option.id, selection.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: option.id,
          }),
        ),
      );
    }
  });
}
