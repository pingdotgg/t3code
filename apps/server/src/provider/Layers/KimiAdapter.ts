import {
  type KimiSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  applyKimiAcpModeSelection,
  applyKimiAcpModelSelection,
  currentKimiModelIdFromConfigOptions,
  isKimiModelCatalogEmpty,
  makeKimiAcpRuntime,
  makeKimiAuthRequiredError,
  resolveKimiAcpBaseModelId,
} from "../acp/KimiAcpSupport.ts";
import type { KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { makeStandardAcpAdapter, type StandardAcpAdapterConfig } from "./StandardAcpAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kimi");

export interface KimiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

function applyKimiSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    // Kimi has no session/set_mode RPC: both model and mode changes go
    // through session/set_config_option, so that is the only method tag
    // this adapter can ever report.
    readonly method: "session/set_config_option";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      const configOptions = yield* input.runtime.getConfigOptions;
      if (isKimiModelCatalogEmpty(configOptions)) {
        return yield* Effect.fail(
          input.mapError({
            cause: makeKimiAuthRequiredError(),
            method: "session/set_config_option",
          }),
        );
      }
      yield* applyKimiAcpModelSelection({
        runtime: input.runtime,
        currentModelId: currentKimiModelIdFromConfigOptions(configOptions),
        requestedModelId: resolveKimiAcpBaseModelId(input.modelSelection.model),
        mapError: (cause) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    yield* applyKimiAcpModeSelection({
      runtime: input.runtime,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      mapError: (cause) =>
        input.mapError({
          cause,
          method: "session/set_config_option",
        }),
    });
  });
}

export function makeKimiAdapter(kimiSettings: KimiSettings, options?: KimiAdapterLiveOptions) {
  const makeRuntime: StandardAcpAdapterConfig["makeRuntime"] = (input) =>
    makeKimiAcpRuntime({
      ...input,
      kimiSettings,
    });

  return makeStandardAcpAdapter(
    {
      provider: PROVIDER,
      defaultInstanceId: ProviderInstanceId.make("kimi"),
      displayName: "Kimi Code",
      makeRuntime,
      applySessionConfiguration: applyKimiSessionConfiguration,
      resolveBaseModelId: resolveKimiAcpBaseModelId,
    },
    options,
  ).pipe(Effect.map((adapter): KimiAdapterShape => adapter));
}
