import {
  type DevinSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { checkDevinExecutable, readDevinModels, runDevinCommand } from "../acp/DevinAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "../providerSnapshot.ts";

export const buildDevinProviderSnapshot = Effect.fn("buildDevinProviderSnapshot")(function* (
  settings: DevinSettings,
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel> = [],
  slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [
    { name: "compact", description: "Summarize the conversation and reduce context usage" },
  ],
) {
  return {
    ...buildServerProvider({
      presentation: {
        displayName: "Devin",
        badgeLabel: "Early Access",
        showInteractionModeToggle: true,
      },
      enabled: settings.enabled,
      checkedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
      models: providerModelsFromSettings(models, settings.customModels, { optionDescriptors: [] }),
      slashCommands,
      probe,
    }),
    supportsTextGeneration: false,
  };
});

export const initialDevinProviderSnapshot = (settings: DevinSettings) =>
  buildDevinProviderSnapshot(settings, {
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking Devin CLI…"
      : "Enable Devin after installing the CLI and running devin auth login on this environment.",
  });

/** Status checks use stored credentials; they never start an interactive login or prompt. */
export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  previousModels: ReadonlyArray<ServerProviderModel> = [],
) {
  if (!settings.enabled) return yield* initialDevinProviderSnapshot(settings);
  const probe = yield* Effect.gen(function* () {
    const version = yield* checkDevinExecutable(settings, environment);
    if (environment.WINDSURF_API_KEY?.trim()) {
      return {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated", type: "apiKey" },
      } satisfies ProviderProbeResult;
    }
    const auth = yield* runDevinCommand(settings, environment, ["auth", "status"]);
    const output = `${auth.stdout}\n${auth.stderr}`;
    if (/not logged in|not authenticated/i.test(output)) {
      return {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Run devin auth login with the configured CLI on this environment, then refresh provider status.",
      } satisfies ProviderProbeResult;
    }
    if (auth.code === 0 && /logged in|authenticated/i.test(output)) {
      return {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated" },
      } satisfies ProviderProbeResult;
    }
    return {
      installed: true,
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Devin sign-in. Run devin auth status on this environment.",
    } satisfies ProviderProbeResult;
  }).pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.catch((cause) =>
      Effect.succeed({
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(cause)
          ? "Devin CLI was not found. Install it from https://docs.devin.ai/cli, then run devin auth login."
          : cause.message,
      } satisfies ProviderProbeResult),
    ),
  );
  if (probe.status !== "ready") return yield* buildDevinProviderSnapshot(settings, probe);
  return yield* readDevinModels(settings, environment).pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.flatMap((models) => buildDevinProviderSnapshot(settings, probe, models)),
    Effect.catch((cause) =>
      buildDevinProviderSnapshot(
        settings,
        {
          ...probe,
          status: "warning",
          message: `Could not load Devin models: ${cause.message}`,
        },
        previousModels,
      ),
    ),
  );
});
