import { ProviderDriverKind, type CopilotSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import {
  authSnapshotFromCopilotSdk,
  createCopilotClient,
  formatCopilotProbeError,
  modelsFromCopilotSdk,
  toCopilotProbeError,
  versionFromCopilotStatus,
} from "../copilotRuntime.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;

export function makePendingCopilotProvider(settings: CopilotSettings): ServerProviderDraft {
  const checkedAt = DateTime.formatIso(DateTime.nowUnsafe());
  const models = modelsFromCopilotSdk({
    models: [],
    customModels: settings.customModels,
  });

  if (!settings.enabled) {
    return buildServerProvider({
      driver: PROVIDER,
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    driver: PROVIDER,
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot SDK availability...",
    },
  });
}

export function checkCopilotProviderStatus(input: {
  readonly settings: CopilotSettings;
  readonly cwd: string;
  readonly baseDirectory?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): Effect.Effect<ServerProviderDraft> {
  if (!input.settings.enabled) {
    return Effect.succeed(makePendingCopilotProvider(input.settings));
  }

  const fallback = (cause: unknown, version: string | null = null) => {
    const checkedAt = DateTime.formatIso(DateTime.nowUnsafe());
    const failure = formatCopilotProbeError({
      cause,
      settings: input.settings,
    });
    return buildServerProvider({
      driver: PROVIDER,
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromCopilotSdk({
        models: [],
        customModels: input.settings.customModels,
      }),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  return Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;

    return yield* Effect.acquireUseRelease(
      createCopilotClient({
        settings: input.settings,
        cwd: input.cwd,
        ...(input.baseDirectory ? { baseDirectory: input.baseDirectory } : {}),
        ...(input.environment ? { env: input.environment } : {}),
        platform,
        logLevel: "error",
      }).pipe(Effect.mapError(toCopilotProbeError)),
      (client) =>
        Effect.tryPromise({
          try: async () => {
            const checkedAt = DateTime.formatIso(DateTime.nowUnsafe());
            await client.start();
            const [status, authStatus, models] = await Promise.all([
              client.getStatus(),
              client.getAuthStatus(),
              client.listModels(),
            ]);
            const authSnapshot = authSnapshotFromCopilotSdk(authStatus);
            const providerModels = modelsFromCopilotSdk({
              models,
              customModels: input.settings.customModels,
            });
            const hasBuiltInModels = models.length > 0;

            return buildServerProvider({
              driver: PROVIDER,
              presentation: COPILOT_PRESENTATION,
              enabled: true,
              checkedAt,
              models: providerModels,
              probe: {
                installed: true,
                version: versionFromCopilotStatus(status),
                status:
                  authSnapshot.status !== "ready"
                    ? authSnapshot.status
                    : hasBuiltInModels
                      ? "ready"
                      : "warning",
                auth: authSnapshot.auth,
                ...(authSnapshot.message
                  ? { message: authSnapshot.message }
                  : hasBuiltInModels
                    ? {}
                    : { message: "Copilot did not report any available models for this account." }),
              },
            });
          },
          catch: toCopilotProbeError,
        }).pipe(Effect.catch((cause) => Effect.succeed(fallback(cause)))),
      (client) => Effect.promise(() => client.stop()).pipe(Effect.ignore({ log: true })),
    ).pipe(Effect.catch((cause) => Effect.succeed(fallback(cause))));
  });
}
