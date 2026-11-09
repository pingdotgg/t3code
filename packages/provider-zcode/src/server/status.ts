import { type CustomModelSetting, type ServerProviderModel } from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";
import { resolveZcodeLaunchCommand } from "./zcodeRuntime.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

const ZCODE_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "default", name: "ZCode default", isCustom: false, capabilities: {} },
  {
    slug: "account:zai-individual-coding-plan/GLM-5.3",
    name: "GLM-5.3",
    isCustom: false,
    capabilities: {},
  },
  {
    slug: "account:zai-individual-coding-plan/GLM-5.3-Flash",
    name: "GLM-5.3 Flash",
    isCustom: false,
    capabilities: {},
  },
];

function zcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(ZCODE_FALLBACK_MODELS, customModels ?? [], {});
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

/** Auth is CLI-managed (`zcode login`); the probe only reads the credential store's active provider. */
export const zcodeAuthFromCredentials = (
  data: unknown,
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
  // The CLI store is a JSON object keyed by credential id.
  if (typeof data === "object" && data !== null) {
    const active = (data as Record<string, unknown>)["oauth:active_provider"];
    if (active === undefined) return "unauthenticated";
    return typeof active === "string" && active.length > 0 ? "authenticated" : "unknown";
  }
  return "unknown";
};

const decodeCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readZcodeAuthStatus = Effect.fn("ZcodeProviderStatus.readAuthStatus")(function* (
  fileSystem: FileSystem.FileSystem,
  credentialsPath: string,
): Effect.fn.Return<"authenticated" | "unauthenticated" | "unknown", never, never> {
  const raw = yield* fileSystem.readFile(credentialsPath).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.orElseSucceed(() => undefined),
  );
  if (raw === undefined) return "unauthenticated" as const;
  return zcodeAuthFromCredentials(Option.getOrUndefined(decodeCredentials(raw)));
});

const resolveZcodeCredentialsPath = (environment: NodeJS.ProcessEnv): string => {
  const dataBaseDir = environment.ZCODE_DATA_BASE_DIR?.trim() || environment.HOME || "";
  return `${dataBaseDir}/.zcode/v2/credentials.json`;
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
    yield* Effect.logWarning("ZCode CLI health check failed.", { errorTag: error._tag });
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
    resolveZcodeCredentialsPath(environment),
  );
  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: zcodeSettings.enabled,
    checkedAt,
    models: fallbackModels,
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
