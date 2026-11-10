import * as NodeOS from "node:os";
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";
import { resolveZcodeCatalogFiles, resolveZcodeLaunchCommand } from "./zcodeRuntime.ts";
import { zcodeEntitledModels, zcodeOAuthSelectedFamilies } from "./zcodeRequestAuth.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** `zcode doctor --json` reports cli.version, the wire-protocol carrier T3 depends on. */
const MINIMUM_ZCODE_VERSION = "0.17.0";

const decodeDoctorOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      cli: Schema.Struct({ version: Schema.optional(Schema.String) }),
    }),
  ),
);

/**
 * "default" defers to the model the signed-in ZCode CLI resolves on its own; the rest of the
 * picker is enumerated from the CLI's injected catalog + entitlement ladder at probe time, so
 * models the plan adds later appear without an adapter change.
 */
const ZCODE_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "ZCode default",
  isCustom: false,
  isDefault: true,
  capabilities: {},
};

function zcodeReasoningCapabilities(levels: ReadonlyArray<string>): ModelCapabilities {
  if (levels.length === 0) return {};
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningLevel",
        label: "Reasoning",
        type: "select",
        role: "reasoning",
        options: levels.map((level) => ({
          id: level,
          label: level.charAt(0).toUpperCase() + level.slice(1),
        })),
      },
    ],
  });
}

const zcodeEntitledPickerModels = Effect.fn("ZcodeProviderStatus.entitledModels")(function* (
  fileSystem: FileSystem.FileSystem,
  environment: NodeJS.ProcessEnv,
) {
  const catalogFiles = yield* resolveZcodeCatalogFiles(fileSystem, environment);
  if (catalogFiles.builtinCatalog === undefined || catalogFiles.builtinPath === undefined) {
    return [];
  }
  const entitled = yield* zcodeEntitledModels(fileSystem, {
    builtinPath: catalogFiles.builtinPath,
    builtinCatalog: catalogFiles.builtinCatalog,
    environment,
  });
  return entitled.map((model): ServerProviderModel => {
    const capabilities = zcodeReasoningCapabilities(model.reasoningLevels);
    return {
      slug: `${model.providerId}/${model.modelId}`,
      name: model.modelId,
      subProvider: model.providerId,
      isCustom: false,
      capabilities: Object.keys(capabilities).length === 0 ? {} : capabilities,
    };
  });
});

function zcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  entitledModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [ZCODE_DEFAULT_MODEL, ...entitledModels],
    customModels ?? [],
    {},
  );
}

const runZcodeDoctor = Effect.fn("ZcodeProviderStatus.runDoctor")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
) {
  const command = yield* resolveZcodeLaunchCommand(zcodeSettings, environment, fileSystem);
  const spawnCommand = yield* resolveSpawnCommand(command, ["doctor", "--json"], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * Auth is CLI-managed (`zcode login`); the probe derives status from the same credential-store
 * keys and setting.json plan selections the provisioning ladder accepts, so an account that can
 * make ZCode requests never shows a false `zcode login` warning.
 */
export const zcodeAuthFromCredentials = (
  data: unknown,
  setting: unknown,
): "authenticated" | "unauthenticated" | "unknown" => {
  if (Array.isArray(data)) {
    const hasActiveProvider = data.some(
      (entry) =>
        Array.isArray(entry) &&
        entry[0] === "oauth:active_provider" &&
        typeof entry[1] === "string" &&
        entry[1].length > 0,
    );
    return hasActiveProvider ? "authenticated" : "unauthenticated";
  }
  // Object stores are judged like provisioning, which ignores any oauth:active_provider marker.
  if (typeof data === "object" && data !== null) {
    return zcodeOAuthSelectedFamilies(setting, data as Record<string, unknown>).size > 0
      ? "authenticated"
      : "unauthenticated";
  }
  return "unknown";
};

const decodeStoreJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readZcodeAuthStatus = Effect.fn("ZcodeProviderStatus.readAuthStatus")(function* (
  fileSystem: FileSystem.FileSystem,
  credentialsPath: string,
  settingPath: string,
): Effect.fn.Return<"authenticated" | "unauthenticated" | "unknown", never, never> {
  const raw = yield* fileSystem.readFile(credentialsPath).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.orElseSucceed(() => undefined),
  );
  if (raw === undefined) return "unauthenticated" as const;
  const setting = yield* fileSystem.readFileString(settingPath).pipe(Effect.option);
  return zcodeAuthFromCredentials(
    Option.getOrUndefined(decodeStoreJson(raw)),
    Option.isNone(setting) ? undefined : Option.getOrUndefined(decodeStoreJson(setting.value)),
  );
});

const resolveZcodeDataPath = (environment: NodeJS.ProcessEnv, file: string): string => {
  // Windows runs without HOME; os.homedir() (USERPROFILE there) keeps the probe on the real store.
  const dataBaseDir =
    environment.ZCODE_DATA_BASE_DIR?.trim() || environment.HOME || NodeOS.homedir();
  return `${dataBaseDir}/.zcode/v2/${file}`;
};

export const buildInitialZcodeProviderSnapshot = Effect.fn(
  "ZcodeProviderStatus.buildInitialSnapshot",
)(function* (zcodeSettings: ZcodeSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = zcodeModelsFromSettings(zcodeSettings.customModels);
  if (!zcodeSettings.enabled) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }
  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking ZCode CLI availability...",
    },
  });
});

export const checkZcodeProviderStatus = Effect.fn("checkZcodeProviderStatus")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fileSystem = yield* FileSystem.FileSystem;
  const fallbackModels = zcodeModelsFromSettings(zcodeSettings.customModels);

  if (!zcodeSettings.enabled) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runZcodeDoctor(zcodeSettings, environment, fileSystem).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    const detail =
      error instanceof PlatformError.PlatformError
        ? `${error.reason._tag}: ${error.message}`
        : error._tag;
    yield* Effect.logWarning("ZCode CLI health check failed.", { errorTag: error._tag, detail });
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "ZCode CLI (`zcode`) is not installed or not on PATH. Install the ZCode CLI, then run `zcode login`."
          : "Failed to execute ZCode CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "ZCode CLI is installed but timed out while running `zcode doctor`.",
      },
    });
  }

  const probeOutput = versionResult.success.value;
  if (probeOutput.code !== 0) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "ZCode CLI is installed but failed to run.",
      },
    });
  }

  const doctor = Option.getOrUndefined(
    Option.map(decodeDoctorOutput(probeOutput.stdout), (decoded) => decoded.cli),
  );
  const version = doctor?.version ?? parseGenericCliVersion(probeOutput.stdout);
  if (version === null) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `T3 Code could not determine the ZCode CLI version. ZCode ${MINIMUM_ZCODE_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_ZCODE_VERSION) < 0) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `ZCode CLI ${version} is unsupported. Update to ZCode ${MINIMUM_ZCODE_VERSION} or newer.`,
      },
    });
  }

  const authStatus = yield* readZcodeAuthStatus(
    fileSystem,
    resolveZcodeDataPath(environment, "credentials.json"),
    resolveZcodeDataPath(environment, "setting.json"),
  );
  // Enumerate the picker from the CLI's own catalog + entitlement ladder; fall back to the
  // default-only list when the catalog files are absent (fresh installs before first login).
  const entitledModels = yield* zcodeEntitledPickerModels(fileSystem, environment).pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderModel>),
  );
  const models = zcodeModelsFromSettings(zcodeSettings.customModels, entitledModels);
  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: zcodeSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: authStatus === "authenticated" ? "ready" : "warning",
      auth: { status: authStatus, type: "zcode" },
      ...(authStatus === "authenticated"
        ? {}
        : {
            message:
              "ZCode CLI is installed but not signed in. Run `zcode login` in a terminal, then refresh this provider.",
          }),
    },
  });
});
