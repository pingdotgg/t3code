/**
 * CopilotProvider — status checking and model discovery for the GitHub Copilot CLI.
 *
 * @module CopilotProvider
 */
import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeCopilotSdkClient, resolveCopilotBinaryPath } from "../sdk/CopilotSdkClient.ts";
import { buildCopilotSdkModels } from "../sdk/CopilotSdkModels.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
// Discovery runs under the provider's single refresh permit and the SDK's
// `start()` is uninterruptible, so the Effect-level discovery timeout can't cut
// a stalled start. Bound it at the JS level below MODEL_DISCOVERY_TIMEOUT_MS,
// leaving headroom for the bounded stop-on-failure (CLIENT_STOP_TIMEOUT_MS), so
// a wedged start + its cleanup stays within the ~10s discovery budget rather
// than holding the permit for the SDK's much longer internal shutdown timeouts.
const MODEL_DISCOVERY_START_TIMEOUT_MS = 8_000;

// ── Version parsing ──────────────────────────────────────────────────────────

export interface CopilotVersionResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

/**
 * Parse the output of `copilot version`.
 * Example: `GitHub Copilot CLI 1.0.45`
 */
export function parseCopilotVersionOutput(result: CommandResult): CopilotVersionResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  if (result.code !== 0) {
    if (
      isCommandMissingCause({ message: combined }) ||
      lowerOutput.includes("enoent") ||
      lowerOutput.includes("not found") ||
      lowerOutput.includes("command not found")
    ) {
      return {
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "GitHub Copilot CLI (`copilot`) is not installed or not on PATH. Run `npm install -g @github/copilot-cli` or download from GitHub.",
      };
    }
    return {
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Failed to run Copilot CLI health check (exit code ${result.code}).`,
    };
  }

  if (
    lowerOutput.includes("enoent") ||
    lowerOutput.includes("not found") ||
    lowerOutput.includes("command not found")
  ) {
    return {
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI (`copilot`) is not installed or not on PATH.",
    };
  }

  const versionMatch = combined.match(/GitHub Copilot CLI\s+(\d+\.\d+\.\d+)/i);
  const version = versionMatch?.[1]?.trim() ?? null;

  // A zero exit whose output we can't parse a version from is not necessarily
  // the Copilot CLI (e.g. `binaryPath` points at some other executable). Surface
  // a warning instead of reporting a healthy install.
  if (!version) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not parse a version from `copilot version`; ensure the configured binary is the GitHub Copilot CLI.",
    };
  }

  return {
    version,
    status: "ready",
    auth: { status: "unknown" },
  };
}

/**
 * Detect auth status from environment variables.
 * The Copilot CLI checks COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN in order.
 */
export function detectCopilotAuthFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  // Pick the first NON-BLANK token in precedence order: a defined-but-empty
  // COPILOT_GITHUB_TOKEN must not mask a real GH_TOKEN / GITHUB_TOKEN.
  const token = [
    environment["COPILOT_GITHUB_TOKEN"],
    environment["GH_TOKEN"],
    environment["GITHUB_TOKEN"],
  ].find((value) => value?.trim());
  if (token?.trim()) {
    return { status: "authenticated" };
  }
  return { status: "unknown" };
}

// ── Model discovery ──────────────────────────────────────────────────────────

/**
 * Discovers the available Copilot models and their per-model capabilities via
 * the `@github/copilot-sdk` `client.listModels()`. Unlike the retired ACP
 * probe — which advertised one session-global config-option set for every
 * model — this reports real per-model reasoning-effort and context-window
 * support (see {@link buildCopilotSdkModels}). Failures degrade to an empty
 * list so the caller keeps whatever models it already had.
 */
export const discoverCopilotModelsViaSdk = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, never> =>
  makeCopilotSdkClient({
    binaryPath: copilotSettings.binaryPath,
    environment,
    startTimeoutMs: MODEL_DISCOVERY_START_TIMEOUT_MS,
  }).pipe(
    Effect.flatMap((client) => client.listModels),
    Effect.map((models) => buildCopilotSdkModels(models)),
    Effect.scoped,
    Effect.catchCause((cause) =>
      // Never swallow interruption — let refresh/shutdown cancellation propagate
      // instead of masking it as an empty result.
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("Copilot SDK model discovery failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as([] as ReadonlyArray<ServerProviderModel>)),
    ),
  );

export function getCopilotFallbackModels(
  copilotSettings: Pick<CopilotSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], copilotSettings.customModels, EMPTY_CAPABILITIES);
}

// ── Snapshot building ────────────────────────────────────────────────────────

export function buildCopilotProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly copilotSettings: CopilotSettings;
  readonly parsed: CopilotVersionResult;
  readonly auth?: ServerProviderAuth;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const auth = input.auth ?? input.parsed.auth;
  const message =
    [input.parsed.message, input.discoveryWarning]
      .map((m) => m?.trim())
      .filter((m): m is string => Boolean(m))
      .join(" ") || undefined;

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: input.copilotSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.copilotSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: input.parsed.status !== "error" || !message?.includes("not installed"),
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth,
      ...(message ? { message } : {}),
    },
  });
}

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getCopilotFallbackModels(copilotSettings);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
      },
    });
  });
}

// ── Status check ─────────────────────────────────────────────────────────────

const runCopilotVersionCommand = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostPlatform = yield* HostProcessPlatform;
    // Resolve the binary the same way the SDK client does, so a GUI-launched
    // process with a restricted PATH doesn't report an installed CLI as missing.
    const resolvedBinary = yield* Effect.promise(() =>
      resolveCopilotBinaryPath(copilotSettings.binaryPath, environment),
    );
    const command = ChildProcess.make(resolvedBinary, ["version"], {
      env: environment,
      shell: hostPlatform === "win32",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: {
    // Last-known-good discovered catalog, carried across refreshes so a
    // transient discovery failure/timeout doesn't make model selection vanish.
    readonly discoveredModelsRef?: Ref.Ref<ReadonlyArray<ServerProviderModel>>;
  },
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getCopilotFallbackModels(copilotSettings);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runCopilotVersionCommand(copilotSettings, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute Copilot CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI timed out while running `copilot version`.",
      },
    });
  }

  const parsed = parseCopilotVersionOutput(versionProbe.success.value);
  // Check for token-based auth in environment
  const envAuth = detectCopilotAuthFromEnvironment(environment);
  const effectiveAuth: ServerProviderAuth =
    envAuth.status === "authenticated" ? envAuth : parsed.auth;

  // Discover the model catalog during the status check itself (as Cursor/Grok
  // do), so every refresh carries a live catalog instead of resetting to the
  // fallback and re-discovering later. The previously discovered catalog is
  // preserved whenever the fresh probe fails, times out, or comes back empty,
  // so model selection never disappears on a transient hiccup.
  const previousModels = options?.discoveredModelsRef
    ? yield* Ref.get(options.discoveredModelsRef)
    : ([] as ReadonlyArray<ServerProviderModel>);
  let discoveredModels = previousModels;
  let discoveryWarning: string | undefined;

  // Only spawn a runtime for discovery when the CLI is actually healthy: an
  // errored/timed-out/unparseable `copilot version` (parsed.status !== "ready")
  // means an SDK session would fail too, so skip it rather than pay a runtime
  // spawn on every health refresh. (`effectiveAuth` is never "unauthenticated"
  // on the current probes, so it can't serve as a discovery gate here.)
  if (parsed.status === "ready") {
    // `discoverCopilotModelsViaSdk` self-recovers real failures to `[]` and only
    // fails on interruption (which propagates here), so `None` means the timeout
    // fired and `Some([])` means "failed or genuinely no models".
    const discovery = yield* discoverCopilotModelsViaSdk(copilotSettings, environment).pipe(
      Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    );
    if (Option.isNone(discovery)) {
      discoveryWarning = `GitHub Copilot model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms${
        previousModels.length > 0 ? "; using the last known models." : "."
      }`;
    } else if (discovery.value.length === 0) {
      if (previousModels.length === 0) {
        discoveryWarning = "GitHub Copilot model discovery returned no models.";
      }
    } else {
      discoveredModels = discovery.value;
      if (options?.discoveredModelsRef) {
        yield* Ref.set(options.discoveredModelsRef, discoveredModels);
      }
    }
  }

  return buildCopilotProviderSnapshot({
    checkedAt,
    copilotSettings,
    parsed,
    auth: effectiveAuth,
    discoveredModels,
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

// ── Background enrichment ────────────────────────────────────────────────────

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  // Model discovery happens in `checkCopilotProviderStatus` (like Cursor/Grok),
  // so enrichment only republishes update/version advisory metadata.
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(stampIdentity(enrichedSnapshot))),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("Copilot version advisory enrichment failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );
};
