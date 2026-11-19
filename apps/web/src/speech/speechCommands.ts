import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { awaitAtomResult, createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  linkEnvironmentSpeechModels,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  setCloudSpeechKey,
  updateEnvironmentSpeechAcceleration,
  updateEnvironmentSpeechModelUnloadTimeout,
} from "@t3tools/client-runtime/voice-input";
import type {
  CloudSpeechProvider,
  SettingsSecretValue,
  SpeechAcceleration,
  SpeechModelUnloadTimeout,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

type ModelInput = { readonly prepared: PreparedConnection; readonly modelId: string };

class SpeechModelSelectError extends Schema.TaggedError<SpeechModelSelectError>()(
  "SpeechModelSelectError",
  { modelId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "The speech model downloaded, but the environment could not select it.";
  }
}

export const isSpeechModelSelectError = Schema.is(SpeechModelSelectError);

// Keyed by identity: Atom.family compares structurally, and a new connection must read afresh.
function perConnection<T extends object>(make: (prepared: PreparedConnection) => T) {
  const atoms = new WeakMap<PreparedConnection, T>();
  return (prepared: PreparedConnection) => {
    const existing = atoms.get(prepared);
    if (existing) return existing;
    const atom = make(prepared);
    atoms.set(prepared, atom);
    return atom;
  };
}

// Every mounted editor shares one status read per destination; starting a recording refreshes it.
export const speechStatusAtom = perConnection((prepared) =>
  connectionAtomRuntime
    .atom(getEnvironmentSpeechStatus(prepared))
    .pipe(Atom.withLabel("web:speech:status")),
);

export const unreadSpeechStatusAtom: ReturnType<typeof speechStatusAtom> = Atom.make(
  AsyncResult.initial(),
);

// Mounted only while a setup download runs. A failed read keeps the last progress and the next tick retries.
export const speechDownloadProgressAtom = perConnection((prepared) =>
  connectionAtomRuntime
    .atom(
      Stream.tick("1 second").pipe(
        Stream.drop(1),
        Stream.mapEffect(() =>
          getEnvironmentSpeechModels(prepared).pipe(
            Effect.map((result) => result.models),
            Effect.catchCause(() => Effect.succeed(null)),
          ),
        ),
        Stream.filter((models) => models !== null),
      ),
    )
    .pipe(Atom.withLabel("web:speech:download-progress")),
);

export const noSpeechDownloadProgressAtom: ReturnType<typeof speechDownloadProgressAtom> =
  Atom.make(AsyncResult.initial());

export const readSpeechModels = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:read-models",
  execute: (input: {
    readonly prepared: PreparedConnection;
    readonly includeBenchmarks: boolean;
  }) => getEnvironmentSpeechModels(input.prepared, input.includeBenchmarks),
});

export const readSpeechCatalog = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:read-catalog",
  execute: (input: {
    readonly prepared: PreparedConnection;
    readonly includeBenchmarks: boolean;
  }) =>
    Effect.all(
      {
        status: getEnvironmentSpeechStatus(input.prepared),
        catalog: getEnvironmentSpeechModels(input.prepared, input.includeBenchmarks),
      },
      { concurrency: "unbounded" },
    ),
});

const setUpModel = Effect.fn("web.speech.setUpModel")(function* (
  input: ModelInput & {
    /** The model the environment has selected now; a different one is selected after it lands. */
    readonly selectedModelId: string;
    /** False once the request was dismissed or superseded: later stages are skipped. */
    readonly isCurrent: () => boolean;
  },
  registry: AtomRegistry.AtomRegistry,
) {
  const { models } = yield* downloadEnvironmentSpeechModel(input.prepared, input.modelId);
  // A download cancelled from elsewhere still resolves, so select the model only once it landed.
  const installed = models.some(({ id, state }) => id === input.modelId && state === "installed");
  if (!input.isCurrent()) return yield* Effect.interrupt;
  if (installed && input.modelId !== input.selectedModelId) {
    yield* selectEnvironmentSpeechModel(input.prepared, input.modelId).pipe(
      Effect.mapError((cause) => new SpeechModelSelectError({ modelId: input.modelId, cause })),
    );
    if (!input.isCurrent()) return yield* Effect.interrupt;
  }
  const status = yield* awaitAtomResult(registry, speechStatusAtom(input.prepared), {
    refresh: true,
  });
  return {
    ready:
      installed &&
      status.supported &&
      status.modelId === input.modelId &&
      status.state !== "missing-model",
  };
});

/**
 * Download, select when the environment uses another model, then refresh the shared status.
 * Fails with `SpeechModelSelectError` when only the selection failed; `ready: false` means every
 * stage answered but the environment still cannot use the model.
 */
export const setUpSpeechModel = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:set-up-model",
  execute: setUpModel,
});

export const downloadSpeechModel = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:download-model",
  execute: (input: ModelInput) => downloadEnvironmentSpeechModel(input.prepared, input.modelId),
});

export const selectSpeechModel = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:select-model",
  execute: (input: ModelInput) => selectEnvironmentSpeechModel(input.prepared, input.modelId),
});

// Stops the download on the environment. Abandoning the client's wait does not.
export const cancelSpeechModelDownload = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:cancel-model-download",
  execute: (input: ModelInput) =>
    cancelEnvironmentSpeechModelDownload(input.prepared, input.modelId),
});

export const removeSpeechModel = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:remove-model",
  execute: (input: ModelInput) => removeEnvironmentSpeechModel(input.prepared, input.modelId),
});

export const linkSpeechModels = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:link-models",
  execute: (input: { readonly prepared: PreparedConnection; readonly path: string }) =>
    linkEnvironmentSpeechModels(input.prepared, input.path),
});

export const updateSpeechAcceleration = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:update-acceleration",
  execute: (input: {
    readonly prepared: PreparedConnection;
    readonly acceleration: SpeechAcceleration;
  }) => updateEnvironmentSpeechAcceleration(input.prepared, input.acceleration),
});

export const updateSpeechModelUnloadTimeout = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:update-model-unload-timeout",
  execute: (input: {
    readonly prepared: PreparedConnection;
    readonly timeout: SpeechModelUnloadTimeout;
  }) => updateEnvironmentSpeechModelUnloadTimeout(input.prepared, input.timeout),
});

export const saveCloudSpeechKey = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:speech:save-cloud-key",
  execute: (input: {
    readonly prepared: PreparedConnection;
    readonly provider: CloudSpeechProvider;
    readonly value: SettingsSecretValue | null;
  }) => setCloudSpeechKey(input.prepared, input.provider, input.value),
});
