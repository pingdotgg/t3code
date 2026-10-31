import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  nativeUpdate: {
    args: ["update"],
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude") ||
        normalized.endsWith("/.local/bin/claude.exe") ||
        normalized.includes("/.local/share/claude/")
      );
    },
  },
});

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

export const resolveClaudeMaintenance = Effect.fn("ClaudeMaintenance.resolve")(function* (
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
) {
  const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(update, options);
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
