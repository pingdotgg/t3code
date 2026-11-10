import {
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSubProvider,
} from "@t3tools/contracts";
import type { FxSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  FX_DEFAULT_MODEL_SLUG,
  FX_DRIVER_KIND,
  FX_EFFORT_OPTION_DESCRIPTOR,
  FX_SUPPORTED_RUNTIME_MODES,
  type FxModelChoice,
  fxModelSlug,
} from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseCliVersionResult,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  providerProbeEnvironment,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const FX_PRESENTATION = {
  displayName: "fx",
  showInteractionModeToggle: false,
  supportedRuntimeModes: FX_SUPPORTED_RUNTIME_MODES,
} as const;
const FX_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [FX_EFFORT_OPTION_DESCRIPTOR],
});

/** fx's built-in backends, in the order its `provider` option lists them. */
const FX_BUILT_IN_BACKENDS = [
  { id: "gateway", name: "Vercel AI Gateway", login: "fx login" },
  { id: "codex", name: "Codex subscription", login: "fx login codex" },
  { id: "grok", name: "Grok subscription", login: "fx login grok" },
] as const;

/** What `fx status` and `fx models` report for one backend. */
interface FxBackendProbe {
  readonly id: string;
  readonly name: string;
  /** Undefined when its status could not be read. */
  readonly signedIn: boolean | undefined;
  readonly signInHint: string;
  readonly models: ReadonlyArray<string> | undefined;
}

/**
 * "Default" runs what fx would start a new session on in the thread's
 * folder; the label shows the machine-wide choice. Other models carry their
 * backend in the slug, and only signed-in backends list any.
 */
const fxModels = (
  settings: FxSettings,
  defaultModel?: string,
  backends: ReadonlyArray<FxBackendProbe> = [],
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(
    [
      {
        slug: FX_DEFAULT_MODEL_SLUG,
        name: defaultModel === undefined ? "Default" : `Default (${defaultModel})`,
        isCustom: false,
        isDefault: true,
        capabilities: FX_MODEL_CAPABILITIES,
      },
      ...backends.flatMap((backend) =>
        backend.signedIn === false
          ? []
          : [...new Set(backend.models)].map((id) => ({
              slug: fxModelSlug(backend.id, id),
              name: id,
              subProvider: backend.name,
              isCustom: false,
              capabilities: FX_MODEL_CAPABILITIES,
            })),
      ),
    ],
    settings.customModels,
    FX_MODEL_CAPABILITIES,
  );

const fxSubProviders = (
  backends: ReadonlyArray<FxBackendProbe>,
): ReadonlyArray<ServerProviderSubProvider> =>
  backends.map((backend) => {
    const unavailableReason =
      backend.signedIn === false
        ? backend.signInHint
        : backend.models === undefined
          ? "fx could not list this backend's models."
          : undefined;
    return { name: backend.name, ...(unavailableReason ? { unavailableReason } : {}) };
  });

const snapshot = (
  settings: FxSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  defaultModel?: string,
  backends: ReadonlyArray<FxBackendProbe> = [],
): ServerProviderDraft => ({
  ...buildServerProvider({
    // Gives the snapshot its version advisory; fx runs no enrichment pass.
    driver: FX_DRIVER_KIND,
    presentation: FX_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fxModels(settings, defaultModel, backends),
    probe,
  }),
  ...(backends.length > 0 ? { subProviders: fxSubProviders(backends) } : {}),
  // Every `fx acp` session is saved under `~/.fx` and ACP has no session
  // delete, so a throwaway text-generation session would stay on disk.
  supportsTextGeneration: false,
});

export const buildInitialFxProviderSnapshot = (
  settings: FxSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking fx CLI availability..."
        : "fx is disabled in T3 Code settings.",
    }),
  );

const runFxCli = Effect.fn("runFxCli")(function* (
  settings: FxSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const command = settings.binaryPath || "fx";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  );
});

/** Stdout of a successful run, or none. Never opens an ACP session, which fx would save. */
const readFxCli = (
  settings: FxSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) =>
  runFxCli(settings, args, environment, cwd).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.map(Option.filter((output) => output.code === 0)),
    Effect.map(Option.map((output) => output.stdout)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * `fx status --json`: `auth` names the login method, `missing` when signed
 * out. `model_source` names a backend other than the gateway, by its label
 * for a built-in one and its id for a configured endpoint.
 */
const FxStatus = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optional(Schema.String),
    auth_help: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    model_source: Schema.optional(Schema.String),
  }),
);
const decodeFxStatus = Schema.decodeUnknownOption(FxStatus);
const FxModels = Schema.fromJsonString(
  Schema.Struct({ ids: Schema.optional(Schema.Array(Schema.String)) }),
);
const decodeFxModels = Schema.decodeUnknownOption(FxModels);
const FxProfileSettings = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeFxProfileSettings = Schema.decodeUnknownOption(FxProfileSettings);

const VERSION_PROBE_TIMEOUT_MS = 10_000;

function fxAuth(auth: string | undefined): ServerProviderAuth {
  const method = nonEmptyTrimmed(auth);
  if (method === undefined) return { status: "unknown" };
  return method === "missing"
    ? { status: "unauthenticated" }
    : { status: "authenticated", label: method };
}

const fxStatusBackend = (modelSource: string | undefined) => {
  const source = nonEmptyTrimmed(modelSource);
  if (source === undefined) return "gateway";
  return FX_BUILT_IN_BACKENDS.find((backend) => backend.name === source)?.id ?? source;
};

/** Configured endpoints are the `providers` keys of fx's profile settings. */
const readFxConfiguredBackends = Effect.fn("readFxConfiguredBackends")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const home = environment.HOME?.trim();
  if (!home) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(home, ".fx", "settings.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const providers = Option.getOrUndefined(decodeFxProfileSettings(text))?.providers ?? {};
  // fx's own id rule; the built-in names are reserved.
  return Object.keys(providers).filter(
    (id) =>
      /^[A-Za-z][\w-]*$/.test(id) &&
      !FX_BUILT_IN_BACKENDS.some((backend) => backend.id === id.toLowerCase()),
  );
});

/**
 * `FX_PROVIDER` points `fx status` and `fx models` at one backend. fx
 * refuses a backend without a saved model unless `FX_MODEL` names one; any
 * value does, since neither command uses it.
 */
const probeFxBackend = Effect.fn("probeFxBackend")(function* (
  settings: FxSettings,
  environment: NodeJS.ProcessEnv,
  backend: { readonly id: string; readonly name: string; readonly login?: string },
) {
  const env = { ...environment, FX_PROVIDER: backend.id, FX_MODEL: FX_DEFAULT_MODEL_SLUG };
  const status = Option.getOrUndefined(
    Option.flatMap(yield* readFxCli(settings, ["status", "--json"], env), decodeFxStatus),
  );
  const auth = fxAuth(status?.auth).status;
  const signedIn = auth === "unknown" ? undefined : auth === "authenticated";
  const models =
    signedIn === false
      ? undefined
      : Option.getOrUndefined(
          Option.flatMap(yield* readFxCli(settings, ["models", "--json"], env), decodeFxModels),
        )?.ids?.flatMap((id) => nonEmptyTrimmed(id) ?? []);
  return {
    id: backend.id,
    name: backend.name,
    signedIn,
    signInHint:
      backend.login === undefined
        ? (nonEmptyTrimmed(status?.auth_help) ?? "fx has no credential for this backend.")
        : `Signed out. Run \`${backend.login}\` on this machine.`,
    models,
  } satisfies FxBackendProbe;
});

/**
 * Reads `fx --version`, `fx status --json` (the default backend and model)
 * and, for every backend, its sign-in and `fx models --json`.
 */
export const checkFxProviderStatus = Effect.fn("checkFxProviderStatus")(function* (
  settings: FxSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "fx is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runFxCli(settings, ["--version"], probeEnvironment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing ? "fx is not installed or not on PATH." : "Failed to run `fx --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "fx is installed but failed to run.",
    });
  }

  const status = Option.getOrUndefined(
    Option.flatMap(
      yield* readFxCli(settings, ["status", "--json"], probeEnvironment),
      decodeFxStatus,
    ),
  );
  const backends = yield* Effect.forEach(
    [
      ...FX_BUILT_IN_BACKENDS,
      ...(yield* readFxConfiguredBackends(environment)).map((id) => ({ id, name: id })),
    ],
    (backend) => probeFxBackend(settings, probeEnvironment, backend),
    { concurrency: "unbounded" },
  );
  const defaultModel = nonEmptyTrimmed(status?.model);
  const defaultBackend = backends.find(
    (backend) => backend.id === fxStatusBackend(status?.model_source),
  );
  const usable = backends.find((backend) => backend.signedIn !== false && backend.models?.length);
  const signedIn = backends.find((backend) => backend.signedIn === true);
  const statusAuth = fxAuth(status?.auth);
  const auth: ServerProviderAuth =
    statusAuth.status !== "authenticated" && signedIn !== undefined
      ? { status: "authenticated", label: signedIn.name }
      : statusAuth;
  const probe =
    auth.status === "unauthenticated"
      ? { status: "error" as const, message: "Run `fx login` to sign in." }
      : auth.status === "unknown"
        ? {
            status: "warning" as const,
            message: "fx is installed but login state could not be determined.",
          }
        : defaultBackend?.signedIn === false
          ? {
              status: "warning" as const,
              message: `fx's default backend, ${defaultBackend.name}, is signed out. Pick a model on another backend or sign in.`,
            }
          : usable === undefined
            ? {
                status: "warning" as const,
                message:
                  "fx is installed but model listing failed. Model options may be incomplete.",
              }
            : { status: "ready" as const };
  return snapshot(
    settings,
    checkedAt,
    { installed: true, version, auth, ...probe },
    defaultModel,
    backends,
  );
});

/**
 * The backend and model fx starts a new session on in `cwd`, which can come
 * from fx's settings for that folder. Undefined when `fx status` fails.
 */
export const readFxDefaultChoice = Effect.fn("readFxDefaultChoice")(function* (
  settings: FxSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<FxModelChoice | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  const status = Option.getOrUndefined(
    Option.flatMap(
      yield* readFxCli(settings, ["status", "--json"], environment, cwd),
      decodeFxStatus,
    ),
  );
  const model = nonEmptyTrimmed(status?.model);
  return model === undefined
    ? undefined
    : { backend: fxStatusBackend(status?.model_source), model };
});
