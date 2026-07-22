/**
 * SazabiProvider — snapshot/probe logic for the Sazabi **cloud** provider.
 *
 * Scaffold only (PR T1). Sazabi talks to the Sazabi public API over HTTP/SSE
 * (Path A); it is not a local ACP CLI harness. Availability is therefore
 * decided by auth presence rather than a binary version:
 *
 *   - a `SAZABI_TOKEN` in the (merged per-instance) environment marks the
 *     provider authenticated + ready, or
 *   - an optional `sazabi` CLI path can be probed with `whoami` as a
 *     convenience when the token is not set.
 *
 * When neither is present the snapshot reports a clear unavailable reason so
 * the settings UI can tell the user how to authenticate.
 *
 * The live model catalogue + real readiness checks against the public API are
 * deferred to PR T2; until then a single placeholder model is surfaced so a
 * scaffolded instance still resolves a default selection.
 *
 * @module provider/Layers/SazabiProvider
 */
import {
  DEFAULT_SAZABI_MODEL,
  SAZABI_TOKEN_ENV_VAR,
  type ModelCapabilities,
  type SazabiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const SAZABI_PRESENTATION = {
  displayName: "Sazabi",
  badgeLabel: "Early Access",
  // Cloud model switching semantics are finalized in PR T2; keep the toggle
  // off for the scaffold so the UI does not advertise an unimplemented mode.
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const WHOAMI_PROBE_TIMEOUT_MS = 4_000;

/**
 * Guidance surfaced whenever Sazabi has no usable credential. Kept as an
 * exported constant so the driver, adapter, and tests share one wording.
 */
export const SAZABI_MISSING_AUTH_MESSAGE =
  `Sazabi is unavailable: set the ${SAZABI_TOKEN_ENV_VAR} environment variable ` +
  "(or configure a `sazabi` CLI path) to authenticate.";

const SAZABI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_SAZABI_MODEL,
    name: "Sazabi Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function sazabiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = SAZABI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Resolve the Sazabi API token from a (already merged) environment. Returns
 * `undefined` when unset or blank so callers can branch on presence.
 */
export function resolveSazabiToken(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = environment[SAZABI_TOKEN_ENV_VAR]?.trim();
  return token ? token : undefined;
}

export function buildInitialSazabiProviderSnapshot(
  sazabiSettings: SazabiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = sazabiModelsFromSettings(sazabiSettings.customModels);

    if (!sazabiSettings.enabled) {
      return buildServerProvider({
        presentation: SAZABI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Sazabi is disabled in T3 Code settings.",
        },
      });
    }

    // Optimistically reflect token presence before the (async) CLI probe runs.
    const hasToken = resolveSazabiToken(environment) !== undefined;
    return buildServerProvider({
      presentation: SAZABI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: hasToken
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "authenticated", type: "token", label: SAZABI_TOKEN_ENV_VAR },
            message: "Checking Sazabi availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Sazabi availability...",
          },
    });
  });
}

const runSazabiWhoamiCommand = (binaryPath: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["whoami"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Probe Sazabi availability.
 *
 * Availability is driven by auth presence, not a binary version:
 *   1. `SAZABI_TOKEN` present → authenticated + ready.
 *   2. no token but a `binaryPath` configured → run `sazabi whoami`.
 *   3. neither → unavailable with {@link SAZABI_MISSING_AUTH_MESSAGE}.
 */
export const checkSazabiProviderStatus = Effect.fn("checkSazabiProviderStatus")(function* (
  sazabiSettings: SazabiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = sazabiModelsFromSettings(sazabiSettings.customModels);

  if (!sazabiSettings.enabled) {
    return buildServerProvider({
      presentation: SAZABI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Sazabi is disabled in T3 Code settings.",
      },
    });
  }

  // 1. Token auth — the primary path for a cloud provider.
  if (resolveSazabiToken(environment) !== undefined) {
    return buildServerProvider({
      presentation: SAZABI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", type: "token", label: SAZABI_TOKEN_ENV_VAR },
      },
    });
  }

  // 2. Optional CLI fallback probe when a `sazabi` binary is configured.
  const binaryPath = sazabiSettings.binaryPath.trim();
  if (binaryPath) {
    const whoamiResult = yield* runSazabiWhoamiCommand(binaryPath, environment).pipe(
      Effect.timeoutOption(WHOAMI_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(whoamiResult)) {
      const error = whoamiResult.failure;
      yield* Effect.logWarning("Sazabi CLI health check failed.", { errorTag: error._tag });
      const commandMissing = isCommandMissingCause(error);
      return buildServerProvider({
        presentation: SAZABI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: !commandMissing,
          version: null,
          status: "error",
          auth: { status: commandMissing ? "unauthenticated" : "unknown" },
          message: commandMissing
            ? SAZABI_MISSING_AUTH_MESSAGE
            : "Failed to execute Sazabi CLI health check.",
        },
      });
    }

    if (Option.isNone(whoamiResult.success)) {
      return buildServerProvider({
        presentation: SAZABI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Sazabi CLI timed out while running `sazabi whoami`.",
        },
      });
    }

    const whoami = whoamiResult.success.value;
    if (whoami.code === 0) {
      return buildServerProvider({
        presentation: SAZABI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated", type: "cli" },
        },
      });
    }

    return buildServerProvider({
      presentation: SAZABI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          "Sazabi CLI is installed but not authenticated. Run `sazabi login` or set " +
          `${SAZABI_TOKEN_ENV_VAR}.`,
      },
    });
  }

  // 3. No credential of any kind.
  return buildServerProvider({
    presentation: SAZABI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unauthenticated" },
      message: SAZABI_MISSING_AUTH_MESSAGE,
    },
  });
});
