import {
  type CustomModelSetting,
  type DevinSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderState,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { DEVIN_API_KEY_ENV, findDevinModelConfigOption } from "../acp/DevinAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  showInteractionModeToggle: true,
} as const;

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

/** Devin's flagship model tier and the `devin acp` session default. */
const DEVIN_DEFAULT_MODEL_SLUG = "swe-2-high";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

/**
 * Parses `devin models list --format json`. The CLI emits a `families` array;
 * each variant's `model_uid` is the id ACP accepts for model selection.
 * Unknown fields are tolerated so newer CLI versions keep decoding.
 */
const DevinModelsListJson = Schema.Struct({
  families: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        slug: Schema.optionalKey(Schema.String),
        variants: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              model_uid: Schema.String,
              label: Schema.optionalKey(Schema.String),
              is_new: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        ),
      }),
    ),
  ),
});

const decodeDevinModelsListJson = Schema.decodeResult(Schema.fromJsonString(DevinModelsListJson));

function devinModelsFromDecodedList(
  decoded: typeof DevinModelsListJson.Type,
): ServerProviderModel[] {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const family of decoded.families ?? []) {
    for (const variant of family.variants ?? []) {
      const slug = variant.model_uid.trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      models.push({
        slug,
        name: nonEmptyString(variant.label) ?? slug,
        isCustom: false,
        ...(variant.is_new === true ? { badge: "new" as const } : {}),
        ...(slug === DEVIN_DEFAULT_MODEL_SLUG ? { isDefault: true } : {}),
        capabilities: EMPTY_MODEL_CAPABILITIES,
      });
    }
  }
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    const first = models[0];
    if (first) models[0] = { ...first, isDefault: true };
  }
  return models;
}

export function parseDevinModelsListJson(output: string): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeDevinModelsListJson(output);
  return Result.isFailure(decoded) ? [] : devinModelsFromDecodedList(decoded.success);
}

export interface DevinAuthStatus {
  /** True or false when the CLI printed a verdict, null when unparseable. */
  readonly authenticated: boolean | null;
  readonly email: string | undefined;
}

/**
 * Parses `devin auth status`. There is no JSON mode, so this reads the human
 * output loosely and returns `authenticated: null` when the text cannot be
 * classified — callers must treat null as "unknown", not a verdict either way.
 *
 * Current logged-in output looks like:
 *
 *     Logged in (via Devin).
 *     User:
 *       Email:             user@example.com
 */
export function parseDevinAuthStatus(output: string): DevinAuthStatus {
  const email = /^\s*Email:\s*(\S+)\s*$/im.exec(output)?.[1];
  // The negative verdict is checked first: "Not logged in" contains the
  // substring "logged in", so the order is load-bearing.
  const authenticated = /not logged in|logged out|no credentials|unauthenticated/i.test(output)
    ? false
    : /logged in/i.test(output)
      ? true
      : null;
  return { authenticated, email };
}

const runDevinCliCommand = (
  devinSettings: Pick<DevinSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface DevinProbeData {
  readonly installed: boolean;
  readonly version: string | null;
  readonly auth: ServerProviderAuth;
  readonly status: ServerProviderState;
  readonly message: string | undefined;
  /**
   * Whether `models` is an authoritative probe result. When false (the
   * version probe failed, auth is unknown, or `devin models list` errored),
   * the snapshot keeps its previous catalog; when true, an empty list means
   * the account genuinely has no catalog (sign-out, empty discovery) and the
   * snapshot drops its built-in models.
   */
  readonly modelsFetched: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * CLI-only health probe: `devin version` for install + version, `devin auth
 * status` for credentials, and `devin models list --format json` for the
 * account catalog. It never spawns `devin acp`, so a probe can never open a
 * browser login.
 */
export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: Pick<DevinSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<DevinProbeData, never, ChildProcessSpawner.ChildProcessSpawner> {
  const versionResult = yield* runDevinCliCommand(devinSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", { errorTag: error._tag });
    return {
      installed: !isCommandMissingCause(error),
      version: null,
      auth: { status: "unknown" },
      status: "error",
      message: isCommandMissingCause(error)
        ? "Devin CLI (`devin`) is not installed or not on PATH."
        : "Failed to execute Devin CLI health check.",
      modelsFetched: false,
      models: [],
    };
  }
  if (Option.isNone(versionResult.success)) {
    return {
      installed: true,
      version: null,
      auth: { status: "unknown" },
      status: "error",
      message: "Devin CLI is installed but timed out while running `devin version`.",
      modelsFetched: false,
      models: [],
    };
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return {
      installed: true,
      version,
      auth: { status: "unknown" },
      status: "error",
      message: "Devin CLI is installed but failed to run.",
      modelsFetched: false,
      models: [],
    };
  }

  const apiKeyAuth: ServerProviderAuth | undefined = environment[DEVIN_API_KEY_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "Devin API key" }
    : undefined;

  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authOutput =
    Result.isSuccess(authResult) &&
    Option.isSome(authResult.success) &&
    authResult.success.value.code === 0
      ? authResult.success.value
      : undefined;
  if (!authOutput) {
    yield* Effect.logWarning("Devin CLI auth status probe failed or timed out.", {
      errorTag: Result.isFailure(authResult)
        ? authResult.failure._tag
        : Option.isNone(authResult.success)
          ? "Timeout"
          : `ExitCode${authResult.success.value.code}`,
    });
  }
  const authStatus = authOutput
    ? parseDevinAuthStatus(`${authOutput.stdout}\n${authOutput.stderr}`)
    : { authenticated: null, email: undefined };

  const auth: ServerProviderAuth =
    apiKeyAuth ??
    (authStatus.authenticated === true
      ? {
          status: "authenticated",
          type: "devin_account",
          label: "Devin account",
          ...(authStatus.email ? { email: authStatus.email } : {}),
        }
      : authStatus.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" });

  if (auth.status === "unauthenticated") {
    return {
      installed: true,
      version,
      auth,
      status: "error",
      message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      // Sign-out is an authoritative empty catalog.
      modelsFetched: true,
      models: [],
    };
  }

  const modelsResult =
    auth.status === "authenticated"
      ? yield* runDevinCliCommand(
          devinSettings,
          ["models", "list", "--format", "json"],
          environment,
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Devin CLI model listing failed.", {
              errorTag: error._tag,
            }),
          ),
          Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
          Effect.result,
        )
      : undefined;
  // A failed, skipped, or undecodable listing keeps the previous catalog; a
  // decoded listing (even an empty one) replaces it.
  const decodedModels =
    modelsResult !== undefined &&
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? decodeDevinModelsListJson(modelsResult.success.value.stdout)
      : undefined;
  const modelsFetched = decodedModels !== undefined && Result.isSuccess(decodedModels);
  const models = modelsFetched ? devinModelsFromDecodedList(decodedModels.success) : [];

  return {
    installed: true,
    version,
    auth,
    // An unreadable auth verdict degrades confidence but does not prove a
    // session would fail; the model picker may just be empty until sign-in.
    status: auth.status === "unknown" ? "warning" : "ready",
    message:
      auth.status === "unknown"
        ? "Could not determine Devin sign-in state. Sessions may prompt for login."
        : undefined,
    modelsFetched,
    models,
  };
});

function devinModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_MODEL_CAPABILITIES);
}

/**
 * Builds the model catalog from a session's `configOptions`. Devin does not
 * advertise `SessionModelState`; models ride the standard
 * `category: "model"` select option, whose current value marks the default.
 */
export function buildDevinModelsFromSession(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findDevinModelConfigOption(configOptions);
  if (!modelOption) return [];
  const currentValue =
    typeof modelOption.currentValue === "string" ? modelOption.currentValue.trim() : undefined;
  const entries = (modelOption.options ?? []).flatMap((entry) =>
    "value" in entry ? [entry] : (entry.options ?? []),
  );
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of entries) {
    const slug = nonEmptyString(entry.value);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: nonEmptyString(entry.name) ?? slug,
      isCustom: false,
      ...(slug === currentValue ? { isDefault: true } : {}),
      capabilities: EMPTY_MODEL_CAPABILITIES,
    });
  }
  return models;
}

/**
 * Session events only arrive while a session is alive, which proves
 * credentials work — so they heal an `unauthenticated` flag the adapter set
 * on a mid-turn error match. A probe-set flag is left alone: `devin auth
 * status` is authoritative about sign-out.
 */
export function healAdapterFlaggedAuth(draft: ServerProviderDraft): Partial<ServerProviderDraft> {
  if (draft.auth.status !== "unauthenticated") return {};
  return {
    auth: { ...draft.auth, status: "authenticated" },
    status: "ready",
    message: undefined,
    supportsTextGeneration: true,
  };
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description?.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

export interface DevinProviderOptions {
  readonly stampIdentity: (snapshot: ServerProviderDraft) => ServerProvider;
  readonly probe: Effect.Effect<DevinProbeData, never>;
  readonly resolveMaintenance: ServerProviderShape["resolveMaintenance"];
}

/**
 * Managed Devin provider snapshot. The CLI probe supplies install/version/
 * auth/models; session callbacks let the adapter push the richer per-session
 * catalog (`configOptions`) and slash commands into the snapshot. Auth status
 * is never browser-driven here — probes are CLI-only by design.
 */
export const makeDevinProvider = Effect.fn("makeDevinProvider")(function* (
  settings: DevinSettings,
  options: DevinProviderOptions,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft: ServerProviderDraft = {
    ...buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: devinModelsFromSettings(settings.customModels),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Devin CLI availability..."
          : "Devin is disabled in T3 Code settings.",
      },
    }),
    supportsConversationRollback: false,
    supportsTextGeneration: false,
  };
  const metadata = yield* SubscriptionRef.make(initialDraft);
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.map((draft) => options.stampIdentity(draft)),
  );

  /**
   * Distinguishes who set `auth.status: "unauthenticated"`: the CLI probe is
   * authoritative and must not be undone, while the adapter's sign-in error
   * match can false-positive on stray upstream errors and may be healed by
   * live session events.
   */
  let adapterFlaggedAuth = false;

  const checkProvider = Effect.fn("DevinProvider.checkProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const probe = yield* options.probe;
    adapterFlaggedAuth = false;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const next = yield* SubscriptionRef.updateAndGet(metadata, (draft) => {
      const { message: _previousMessage, ...rest } = draft;
      const models = probe.modelsFetched
        ? devinModelsFromSettings(settings.customModels, probe.models)
        : draft.models;
      return {
        ...rest,
        installed: probe.installed,
        version: probe.version,
        status: settings.enabled ? probe.status : "disabled",
        auth: probe.auth,
        checkedAt,
        models,
        supportsTextGeneration: probe.auth.status === "authenticated",
        ...(probe.message ? { message: probe.message } : {}),
        // A missing install wipes the discovered catalog and commands.
        ...(probe.installed ? {} : { models: [], slashCommands: [] }),
      } satisfies ServerProviderDraft;
    });
    return options.stampIdentity(next);
  });

  const managed = yield* makeManagedServerProvider({
    resolveMaintenance: options.resolveMaintenance,
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach((draft) => publishSnapshot(options.stampIdentity(draft))),
      ),
  });

  const onSessionStarted = Effect.fn("DevinProvider.onSessionStarted")(function* (
    started: AcpSessionRuntimeStartResult,
  ) {
    adapterFlaggedAuth = false;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (draft) => {
      const { message: _previousMessage, ...rest } = draft;
      const configOptions =
        "configOptions" in started.sessionSetupResult &&
        Array.isArray(started.sessionSetupResult.configOptions)
          ? started.sessionSetupResult.configOptions
          : [];
      // A session without a model config option is not an empty catalog —
      // keep the probed models instead of collapsing to custom-only.
      const sessionBuiltInModels = buildDevinModelsFromSession(configOptions);
      const sessionModels =
        sessionBuiltInModels.length > 0
          ? devinModelsFromSettings(settings.customModels, sessionBuiltInModels)
          : [];
      return {
        ...rest,
        installed: true,
        // A session only reaches this point when the adapter allowed start,
        // which requires the provider to be enabled.
        status: "ready",
        // A started session proves credentials worked. Preserve the
        // type/label/email a probe already recorded and only flip the status.
        auth: { ...draft.auth, status: "authenticated" },
        checkedAt,
        ...(sessionModels.length > 0 ? { models: sessionModels } : {}),
        supportsTextGeneration: true,
      } satisfies ServerProviderDraft;
    });
  });

  const onConfigOptionsUpdated = Effect.fn("DevinProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) {
    const sessionBuiltInModels = buildDevinModelsFromSession(configOptions);
    if (sessionBuiltInModels.length === 0) return;
    const models = devinModelsFromSettings(settings.customModels, sessionBuiltInModels);
    yield* SubscriptionRef.update(metadata, (draft) => {
      const heal = adapterFlaggedAuth ? healAdapterFlaggedAuth(draft) : {};
      if (heal.auth) adapterFlaggedAuth = false;
      return { ...draft, ...heal, models };
    });
  });

  const onAvailableCommands = Effect.fn("DevinProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) {
    const slashCommands = nativeCommands(commands);
    yield* SubscriptionRef.update(metadata, (draft) => {
      const heal = adapterFlaggedAuth ? healAdapterFlaggedAuth(draft) : {};
      if (heal.auth) adapterFlaggedAuth = false;
      return { ...draft, ...heal, slashCommands };
    });
  });

  /**
   * Ran when a session start proves credentials are missing or rejected. The
   * error match can false-positive on stray upstream errors, so the known
   * model catalog and commands are kept — a real sign-out is corrected by the
   * next probe or session start anyway.
   */
  const onAuthRequired = Effect.gen(function* () {
    adapterFlaggedAuth = true;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (draft) =>
        ({
          ...draft,
          auth: { status: "unauthenticated" },
          status: settings.enabled ? "warning" : "disabled",
          supportsTextGeneration: false,
          message: "Devin is not signed in. Run `devin auth login`, then start the thread again.",
          checkedAt,
        }) satisfies ServerProviderDraft,
    );
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onConfigOptionsUpdated,
    onAvailableCommands,
    onAuthRequired,
    snapshotForCwd: (_cwd?: string) => getSnapshot,
  };
});
