import {
  type GrokBuildSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { ChildProcessSpawner, ChildProcess } from "effect/unstable/process";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok-build");

const GROK_BUILD_PRESENTATION = {
  displayName: "Grok Build",
  showInteractionModeToggle: true,
} as const;

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    shortName: "Grok Build",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "composer-2.5",
    name: "Composer 2.5",
    shortName: "Composer 2.5",
    isCustom: false,
    capabilities: null,
  },
];

export const buildInitialGrokBuildProviderSnapshot = (
  settings: GrokBuildSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: GROK_BUILD_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        BUILT_IN_MODELS,
        DRIVER_KIND,
        settings.customModels ?? [],
        { optionDescriptors: [] },
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking for Grok Build CLI...",
      },
    });
  });

export const checkGrokBuildProviderStatus = (
  settings: GrokBuildSettings,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const command = settings.command || "grok";

    // Fast check: grok --version
    const versionCheck = yield* spawner
      .spawn(
        ChildProcess.make(command, ["--version"], {
          env: { ...process.env, ...env },
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.andThen((process) => process.exitCode),
        Effect.scoped,
        Effect.exit,
      );

    if (versionCheck._tag === "Failure") {
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: GROK_BUILD_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          BUILT_IN_MODELS,
          DRIVER_KIND,
          settings.customModels ?? [],
          { optionDescriptors: [] },
        ),
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Grok Build CLI not found.\nWindows: irm https://x.ai/cli/install.ps1 | iex\nmacOS/Linux: curl -fsSL https://x.ai/cli/install.sh | bash",
        },
      });
    }

    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: GROK_BUILD_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        BUILT_IN_MODELS,
        DRIVER_KIND,
        settings.customModels ?? [],
        { optionDescriptors: [] },
      ),
      probe: {
        installed: true,
        version: "available",
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  });
