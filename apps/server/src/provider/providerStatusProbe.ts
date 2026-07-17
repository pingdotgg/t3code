/**
 * providerStatusProbe — shared CLI provider status-probe scaffold.
 *
 * Owns the branch sequence common to the simple `--version` + ACP-discovery
 * provider health checks (disabled → version probe → command-missing →
 * probe-timeout → non-zero-exit → discovery → discovery-failure →
 * discovery-timeout → success). Per-provider specifics — presentation,
 * timeouts, the version/discovery effects, the exact message and log strings,
 * and how a discovery result maps to models + auth — are supplied through
 * {@link CliProviderStatusProbeConfig}.
 *
 * Cursor's provider check deliberately does NOT use this scaffold: it runs a
 * single combined `agent about` probe (version + auth in one call), applies
 * channel / parameterized-model-picker gating and filesystem lookups, and
 * treats discovery failures as an appended warning rather than a hard error.
 * Forcing it through here would risk behavior drift, so it keeps its own flow.
 *
 * @module providerStatusProbe
 */

import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type CommandResult,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "./providerSnapshot.ts";

/** Snapshot `message` strings for each terminal branch of the probe. */
export interface CliProviderStatusProbeMessages {
  readonly disabled: string;
  readonly commandMissing: string;
  readonly healthCheckFailed: string;
  readonly versionProbeTimeout: string;
  readonly nonZeroExit: string;
  readonly discoveryFailed: string;
  /** Includes the timeout duration; caller composes the exact string. */
  readonly discoveryTimeout: string;
}

/** `logWarning` message strings emitted alongside the failure branches. */
export interface CliProviderStatusProbeLogMessages {
  readonly healthCheckFailed: string;
  readonly nonZeroExit: string;
  readonly discoveryFailed: string;
  /** Includes the timeout duration; caller composes the exact string. */
  readonly discoveryTimeout: string;
}

export interface CliProviderStatusProbeConfig<
  EVersion extends { readonly _tag: string },
  RVersion,
  EDiscovery,
  RDiscovery,
> {
  readonly presentation: ServerProviderPresentation;
  /** Always true here — the disabled case is handled before this scaffold runs. */
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly fallbackModels: ReadonlyArray<ServerProviderModel>;
  readonly versionProbeTimeoutMs: number;
  readonly discoveryTimeoutMs: number;
  readonly runVersionCommand: Effect.Effect<CommandResult, EVersion, RVersion>;
  readonly discoverModels: Effect.Effect<
    ReadonlyArray<ServerProviderModel>,
    EDiscovery,
    RDiscovery
  >;
  readonly messages: CliProviderStatusProbeMessages;
  readonly logMessages: CliProviderStatusProbeLogMessages;
  /**
   * Assemble the terminal snapshot from a successful discovery. Providers
   * differ here: Grok maps an empty discovered-model list back to fallback
   * models with unknown auth, while Kimi maps it to an unauthenticated error.
   */
  readonly buildDiscoveredSnapshot: (input: {
    readonly version: string | null;
    readonly discoveredModels: ReadonlyArray<ServerProviderModel>;
  }) => ServerProviderDraft;
}

/**
 * Run the shared CLI provider status-probe branch sequence. The caller owns
 * the enabled check and `checkedAt`; this helper covers everything from the
 * version probe through discovery. Every emitted snapshot, log, and message
 * is supplied by the caller so output stays byte-identical per provider.
 */
export const runCliProviderStatusProbe = <
  EVersion extends { readonly _tag: string },
  RVersion,
  EDiscovery,
  RDiscovery,
>(
  config: CliProviderStatusProbeConfig<EVersion, RVersion, EDiscovery, RDiscovery>,
): Effect.Effect<ServerProviderDraft, never, RVersion | RDiscovery> =>
  Effect.gen(function* () {
    const { presentation, enabled, checkedAt, fallbackModels, messages, logMessages } = config;

    const versionResult = yield* config.runVersionCommand.pipe(
      Effect.timeoutOption(config.versionProbeTimeoutMs),
      Effect.result,
    );

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning(logMessages.healthCheckFailed, {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation,
        enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? messages.commandMissing
            : messages.healthCheckFailed,
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation,
        enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: messages.versionProbeTimeout,
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(versionOutput.stdout + "\n" + versionOutput.stderr);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning(logMessages.nonZeroExit, {
        exitCode: versionOutput.code,
        stdoutLength: versionOutput.stdout.length,
        stderrLength: versionOutput.stderr.length,
      });
      return buildServerProvider({
        presentation,
        enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: messages.nonZeroExit,
        },
      });
    }

    const discoveryExit = yield* config.discoverModels.pipe(
      Effect.timeoutOption(config.discoveryTimeoutMs),
      Effect.exit,
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning(logMessages.discoveryFailed, {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
      return buildServerProvider({
        presentation,
        enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: messages.discoveryFailed,
        },
      });
    }
    if (Option.isNone(discoveryExit.value)) {
      yield* Effect.logWarning(logMessages.discoveryTimeout);
      return buildServerProvider({
        presentation,
        enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: messages.discoveryTimeout,
        },
      });
    }

    return config.buildDiscoveredSnapshot({
      version,
      discoveredModels: discoveryExit.value.value,
    });
  });

/**
 * Shared background version-advisory enrichment used by the simple CLI
 * providers (Grok, Kimi). Republishes update/version advisory metadata and
 * swallows failures as a warning. Providers whose enrichment must be skipped
 * under some condition (e.g. Kimi when unauthenticated) pass `skip: true`.
 */
export const enrichCliProviderSnapshotAdvisory = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean | undefined;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
  readonly warningLogMessage: string;
  readonly skip?: boolean;
}): Effect.Effect<void> => {
  if (input.skip) {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning(input.warningLogMessage, {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
