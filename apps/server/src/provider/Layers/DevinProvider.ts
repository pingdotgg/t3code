/**
 * DevinProvider — status + model-catalog snapshot for the Devin CLI.
 *
 * Probes `devin --version`, `devin auth status`, and
 * `devin models list --format json`. ACP `session/new` exposes the same model
 * list as a `model` config option, but spawning a session just to read the
 * catalog would boot the agent on every health refresh — the JSON listing is
 * cheaper and needs no session.
 *
 * @module DevinProvider
 */
import type {
  DevinSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
const PROVIDER_KIND = ProviderDriverKind.make("devin");

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

const ABOUT_TIMEOUT_MS = 10_000;
const MODELS_TIMEOUT_MS = 15_000;
const DEVIN_CLI_INSTALLATION_DOCS_URL = "https://devin.ai/cli";

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildDevinCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Devin CLI command \`${binaryPath}\` was not found.`,
    `Install the Devin CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
    `See ${DEVIN_CLI_INSTALLATION_DOCS_URL}.`,
  ].join(" ");
}

// ── `devin models list --format json` ────────────────────────────────────

import { devinModelsFromCatalog, type DevinModelsListJson } from "../devinModelCatalog.ts";

export { devinModelsFromCatalog };

function parseDevinModelsJson(raw: string): DevinModelsListJson | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as DevinModelsListJson;
  } catch {
    return undefined;
  }
}

/**
 * Static fallback so the picker is never empty when discovery fails. Uses
 * the same grouped shape as live discovery: one row per base with effort
 * descriptors.
 */
const DEVIN_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = devinModelsFromCatalog({
  families: [
    {
      family_uid: "adaptive",
      family_label: "Adaptive",
      variants: [{ model_uid: "adaptive" }],
    },
    {
      family_uid: "swe-2",
      family_label: "SWE-2",
      aliases: ["swe"],
      variants: [
        { model_uid: "swe-2-high" },
        { model_uid: "swe-2-medium" },
        { model_uid: "swe-2-max" },
      ],
    },
    {
      family_uid: "swe-1.7",
      family_label: "SWE-1.7",
      variants: [{ model_uid: "swe-1-7" }, { model_uid: "swe-1-7-medium" }],
    },
    {
      family_uid: "swe-1.7-lightning",
      family_label: "SWE-1.7 Lightning",
      variants: [{ model_uid: "swe-1-7-lightning" }, { model_uid: "swe-1-7-lightning-medium" }],
    },
    {
      family_uid: "swe-1.6-fast",
      family_label: "SWE-1.6 Fast",
      variants: [{ model_uid: "swe-1-6-fast" }],
    },
  ],
});

function getDevinFallbackModels(devinSettings: DevinSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    DEVIN_FALLBACK_MODELS,
    devinSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

// ── `devin auth status` ──────────────────────────────────────────────────

export interface DevinProbeResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export function parseDevinAuthStatus(
  result: CommandResult,
): Pick<DevinProbeResult, "auth" | "status" | "message"> {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lower = combined.toLowerCase();

  if (
    lower.includes("not logged in") ||
    lower.includes("not authenticated") ||
    lower.includes("no credentials")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Devin CLI is not authenticated. Run `devin auth login` and try again.",
    };
  }

  if (lower.includes("logged in")) {
    const emailMatch =
      result.stdout.match(/^\s*Email:\s+(.+)$/m) ?? result.stdout.match(/^\s*Name:\s+(.+)$/m);
    const email = emailMatch?.[1]?.trim();
    return {
      status: "ready",
      auth: {
        status: "authenticated",
        ...(email ? { email } : {}),
      },
    };
  }

  if (result.code === 0) {
    return { status: "ready", auth: { status: "unknown" } };
  }
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: "Could not verify Devin CLI authentication status.",
  };
}

const runDevinCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      devinSettings.binaryPath || "devin",
      args,
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      devinSettings.binaryPath || "devin",
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.scoped);

export function buildDevinProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly devinSettings: DevinSettings;
  readonly parsed: DevinProbeResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    driver: PROVIDER_KIND,
    presentation: DEVIN_PRESENTATION,
    enabled: input.devinSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.devinSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getDevinFallbackModels(devinSettings);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const probeFailure = (message: string, installed = true): ServerProviderDraft =>
    buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message,
      },
    });

  // Version probe first — it proves the binary exists and is executable.
  const versionProbe = yield* runDevinCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", { errorTag: error._tag });
    return probeFailure(
      isCommandMissingCause(error)
        ? buildDevinCliCommandMissingMessage(devinSettings.binaryPath || "devin")
        : "Failed to execute Devin CLI health check.",
      !isCommandMissingCause(error),
    );
  }
  if (Option.isNone(versionProbe.success)) {
    return probeFailure("Devin CLI is installed but timed out while running `devin --version`.");
  }
  const version = parseGenericCliVersion(
    `${versionProbe.success.value.stdout}\n${versionProbe.success.value.stderr}`,
  );

  // Auth probe.
  const authProbe = yield* runDevinCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );

  const parsed: DevinProbeResult = (() => {
    if (Result.isFailure(authProbe)) {
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not run `devin auth status`.",
      };
    }
    if (Option.isNone(authProbe.success)) {
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin CLI timed out while running `devin auth status`.",
      };
    }
    const auth = parseDevinAuthStatus(authProbe.success.value);
    return { version, ...auth };
  })();

  // Model catalog — skipped when unauthenticated since the CLI cannot list
  // anything useful then.
  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  if (parsed.auth.status !== "unauthenticated") {
    const modelsExit = yield* Effect.exit(
      runDevinCommand(devinSettings, ["models", "list", "--format", "json"], environment).pipe(
        Effect.timeoutOption(MODELS_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(modelsExit)) {
      yield* Effect.logWarning("Devin model discovery failed", {
        errorTag: causeErrorTag(modelsExit.cause),
      });
      discoveryWarning = "Devin model discovery failed.";
    } else if (Option.isNone(modelsExit.value)) {
      discoveryWarning = "Devin model discovery timed out.";
    } else {
      const models = devinModelsFromCatalog(parseDevinModelsJson(modelsExit.value.value.stdout));
      if (models.length === 0) {
        discoveryWarning = "Devin model discovery returned no models.";
      } else {
        discoveredModels = Option.some(models);
      }
    }
  }

  return buildDevinProviderSnapshot({
    checkedAt,
    devinSettings,
    parsed,
    discoveredModels: Option.getOrElse(
      Option.filter(discoveredModels, (models) => models.length > 0),
      () => fallbackModels,
    ),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

export const buildInitialDevinProviderSnapshot = (
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getDevinFallbackModels(devinSettings);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });

/**
 * Background maintenance enrichment: republishes update/version advisory
 * metadata without re-running model discovery.
 */
export const enrichDevinSnapshot = (input: {
  readonly settings: DevinSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};
