import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ProcessRunner } from "../../processRunner.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { mapPiModelCatalog, type PiModelCatalogEntry } from "./PiModels.ts";
import { makePiSessionRuntime, type PiSessionRuntimeError } from "./PiSessionRuntime.ts";
import { parsePiVersion, PI_MINIMUM_VERSION, validatePiLaunchArgs } from "./PiRuntime.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

export interface PiModelCatalogProbeInput {
  readonly binaryPath: string;
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type PiModelCatalogProbe<R = never> = (
  input: PiModelCatalogProbeInput,
) => Effect.Effect<ReadonlyArray<PiModelCatalogEntry>, PiSessionRuntimeError, R>;

/**
 * Discover the exact model + thinking catalog from Pi RPC without creating a
 * native session. Each catalog entry is selected before querying its valid
 * thinking levels because Pi exposes that capability for the active model.
 */
export const discoverPiModelCatalog: PiModelCatalogProbe<
  ChildProcessSpawner.ChildProcessSpawner
> = (input) =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makePiSessionRuntime({
        binaryPath: input.binaryPath,
        configDirectory: input.configDirectory,
        launchArgs: input.launchArgs,
        cwd: input.cwd,
        environment: input.environment,
      });
      yield* runtime.start();
      const models = yield* runtime.getAvailableModels();
      return yield* Effect.forEach(
        models,
        (model) =>
          Effect.gen(function* () {
            yield* runtime.setModel({ provider: model.provider, modelId: model.id });
            const [thinkingLevels, state] = yield* Effect.all(
              [runtime.getAvailableThinkingLevels(), runtime.getState()],
              { concurrency: 1 },
            );
            return {
              model,
              thinkingLevels,
              ...(state.thinkingLevel ? { currentThinkingLevel: state.thinkingLevel } : {}),
            } satisfies PiModelCatalogEntry;
          }),
        { concurrency: 1 },
      );
    }),
  );

function piSnapshot(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models?: ServerProviderDraft["models"];
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string | undefined;
}): ServerProviderDraft {
  return buildServerProvider({
    driver: PI_DRIVER,
    presentation: PI_PRESENTATION,
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: input.models ?? [],
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: { status: "unknown" },
      ...(input.message ? { message: input.message } : {}),
    },
  });
}

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return piSnapshot({
      enabled: settings.enabled,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      message: settings.enabled
        ? "Pi provider status has not been checked in this session yet."
        : "Pi is disabled in T3 Code settings.",
    });
  });

export function checkPiProviderStatus<R = never>(
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  discoverModels?: PiModelCatalogProbe<R>,
  cwd = process.cwd(),
): Effect.Effect<ServerProviderDraft, never, ProcessRunner | R> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!settings.enabled) {
      return piSnapshot({
        enabled: false,
        checkedAt,
        installed: false,
        version: null,
        status: "warning",
        message: "Pi is disabled in T3 Code settings.",
      });
    }

    const launchArgsValidationError = validatePiLaunchArgs(settings.launchArgs);
    if (launchArgsValidationError) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: false,
        version: null,
        status: "error",
        message: launchArgsValidationError,
      });
    }

    const processRunner = yield* ProcessRunner;
    const versionExit = yield* Effect.exit(
      processRunner.run({
        command: settings.binaryPath || "pi",
        args: ["--version"],
        env: settings.configDirectory
          ? { ...environment, PI_AGENT_DIR: settings.configDirectory }
          : environment,
      }),
    );
    if (versionExit._tag === "Failure") {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: false,
        version: null,
        status: "error",
        message: `Pi CLI (${settings.binaryPath || "pi"}) is not installed or could not be started. Check the binary path.`,
      });
    }

    const versionResult = versionExit.value;
    if (versionResult.timedOut || versionResult.code !== 0) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: null,
        status: "error",
        message: versionResult.timedOut
          ? "Pi CLI version check timed out. Check the selected binary and try again."
          : "Pi CLI version check failed. Check the selected binary and try again.",
      });
    }

    const parsedVersion = parsePiVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (parsedVersion._tag === "Invalid") {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: null,
        status: "error",
        message: "Could not determine the Pi CLI version. Check that the selected binary is Pi.",
      });
    }

    if (parsedVersion._tag === "Unsupported") {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: parsedVersion.version,
        status: "error",
        message: `Pi v${parsedVersion.version} is too old. Upgrade to v${PI_MINIMUM_VERSION} or later.`,
      });
    }

    if (!discoverModels) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: parsedVersion.version,
        status: "ready",
      });
    }

    const catalogExit = yield* Effect.exit(
      discoverModels({
        binaryPath: settings.binaryPath || "pi",
        configDirectory: settings.configDirectory,
        launchArgs: settings.launchArgs,
        cwd,
        environment,
      }),
    );
    if (Exit.isFailure(catalogExit)) {
      return piSnapshot({
        enabled: true,
        checkedAt,
        installed: true,
        version: parsedVersion.version,
        status: "error",
        message:
          "Pi RPC model discovery failed. Check the selected Pi configuration and try again.",
      });
    }

    return piSnapshot({
      enabled: true,
      checkedAt,
      installed: true,
      version: parsedVersion.version,
      status: "ready",
      models: mapPiModelCatalog(catalogExit.value),
    });
  });
}
