import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
  type ProviderMaintenanceResolverServices,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";

const NATIVE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const UpdateChannelSettings = fromLenientJson(
  Schema.Struct({ autoUpdatesChannel: Schema.optional(Schema.Literals(["latest", "stable"])) }),
);
const NativeVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));

const update = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  mise: { tool: "claude" },
  nativeUpdate: {
    args: ["update"],
    // On Unix the native launcher links into ${XDG_DATA_HOME:-~/.local/share}/claude/versions; a
    // plain file at ~/.local/bin/claude is a wrapper whose owner `claude update` cannot see.
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude.exe") ||
        normalized.includes("/.local/share/claude/") ||
        normalized.includes("/claude/versions/")
      );
    },
    requiresCommandPath: true,
  },
});

const CMUX_CLAUDE_WRAPPER_SHIM = "CMUX_CLAUDE_WRAPPER_SHIM";
const CMUX_CLAUDE_WRAPPER_SHIM_ROOT = "CMUX_CLAUDE_WRAPPER_SHIM_ROOT";

// CMUX puts a temporary `claude` shim first on PATH. Its markers identify that
// shim, so maintenance can inspect the next PATH entry without changing how
// Claude itself launches through CMUX.
function isMarkedCmuxClaudeShim(context: ProviderMaintenanceResolutionContext): boolean {
  const shimPath = context.env[CMUX_CLAUDE_WRAPPER_SHIM]?.trim();
  const shimRoot = context.env[CMUX_CLAUDE_WRAPPER_SHIM_ROOT]?.trim();
  const path = context.env.PATH;
  if (context.platform !== "darwin" || context.binaryPath !== "claude") return false;
  if (!shimPath || !shimRoot || !path) return false;
  return (
    context.resolvedCommandPath === shimPath &&
    shimPath.startsWith(`${shimRoot}/`) &&
    path.split(":").includes(shimRoot)
  );
}

const resolveClaudeMaintenanceContext = Effect.fn("resolveClaudeMaintenanceContext")(function* (
  context: ProviderMaintenanceResolutionContext | null,
) {
  if (!context || !isMarkedCmuxClaudeShim(context)) {
    return context;
  }

  const shimRoot = context.env[CMUX_CLAUDE_WRAPPER_SHIM_ROOT]!.trim();
  const env = {
    ...context.env,
    PATH: context.env
      .PATH!.split(":")
      .filter((entry) => entry !== shimRoot)
      .join(":"),
  };
  const resolvedCommandPath = yield* resolveCommandPath(context.binaryPath, { env }).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (!resolvedCommandPath || resolvedCommandPath === context.resolvedCommandPath) {
    return context;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (!realCommandPath) {
    return context;
  }

  return {
    ...context,
    resolvedCommandPath,
    realCommandPath,
    env,
  } satisfies ProviderMaintenanceResolutionContext;
});

export function makeClaudeMaintenanceResolver(): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: Effect.fn("ClaudeMaintenanceResolver.resolve")(function* (context) {
      const resolvedContext = yield* resolveClaudeMaintenanceContext(context);
      return yield* update.resolve(resolvedContext);
    }),
  };
}

const readUpdateChannel = Effect.fn("ClaudeMaintenance.readUpdateChannel")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const managedDirectory =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "win32"
        ? path.join(environment.PROGRAMFILES || "C:\\Program Files", "ClaudeCode")
        : "/etc/claude-code";
  const dropInDirectory = path.join(managedDirectory, "managed-settings.d");
  const dropIns = yield* fs.readDirectory(dropInDirectory).pipe(Effect.orElseSucceed(() => []));
  // The updater inherits the server's config directory, not the instance's homePath.
  const configDirectory = yield* resolveClaudeHomePath({ homePath: "" }, environment);
  const settingsPaths = [
    path.join(configDirectory, "settings.json"),
    path.join(managedDirectory, "managed-settings.json"),
    ...dropIns
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .toSorted()
      .map((name) => path.join(dropInDirectory, name)),
  ];
  const channels = yield* Effect.forEach(settingsPaths, (settingsPath) =>
    fs.readFileString(settingsPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(UpdateChannelSettings)),
      Effect.map((settings) => settings.autoUpdatesChannel),
      Effect.orElseSucceed(() => undefined),
    ),
  );
  return channels.findLast((channel) => channel !== undefined) ?? "latest";
});

const resolveClaudeMaintenance = Effect.fn("ClaudeMaintenance.resolve")(function* (
  capabilities: ProviderMaintenanceCapabilities,
) {
  if (capabilities.update?.lockKey !== "claudeAgent-native") return capabilities;
  const channel = yield* readUpdateChannel();
  const client = yield* HttpClient.HttpClient;
  const url = `${NATIVE_RELEASES}/${channel}`;
  return {
    ...capabilities,
    latestVersion: null,
    latestVersionCacheKey: url,
    lookupLatestVersion: client.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map((text) => text.trim()),
      Effect.flatMap(Schema.decodeUnknownEffect(NativeVersion)),
      Effect.timeoutOption("4 seconds"),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    ),
  };
});

export const makeClaudeMaintenanceResolution = Effect.fn("ClaudeMaintenance.make")(function* (
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
) {
  const services = yield* Effect.context<
    ProviderMaintenanceResolverServices | HttpClient.HttpClient
  >();
  const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
    resolveProviderMaintenanceCapabilitiesEffect(makeClaudeMaintenanceResolver(), options).pipe(
      Effect.provideContext(services),
    ),
  );
  const resolve: typeof resolveInstallation = (refreshOptions) =>
    resolveInstallation(refreshOptions).pipe(
      Effect.flatMap(resolveClaudeMaintenance),
      Effect.provideContext(services),
    );
  return resolve;
});
