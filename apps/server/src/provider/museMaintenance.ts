import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { makeMuseEnvironment } from "./museSdk.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "./providerMaintenance.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

const DRIVER = ProviderDriverKind.make("muse");
const STABLE_CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";
const ChannelManifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/)),
});

/** Muse prints both a display version and a release revision; prefer the latter. */
export function parseMuseVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0] ?? parseGenericCliVersion(output);
}

function comparableMuseVersion(version: string): string {
  // Make the release sequence numeric for semver comparison (R9 precedes R10).
  return version.replace(/-R(\d+)(?:\.(\d+))?$/, "-release.$1.$2").replace(/\.$/, ".0");
}

export const compareMuseVersions = (current: string, latest: string) =>
  compareSemverVersions(comparableMuseVersion(current), comparableMuseVersion(latest));

/** Only the official launcher owns an update channel; a standalone binary cannot update itself. */
export const museMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.gen(function* () {
      const manual = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
      });
      if (!context || context.platform === "win32") return manual;
      const fs = yield* FileSystem.FileSystem;
      const isLauncher = yield* Effect.gen(function* () {
        const stat = yield* fs.stat(context.realCommandPath);
        if (Number(stat.size) > 128 * 1_024) return false;
        const source = yield* fs.readFileString(context.realCommandPath);
        return source.includes("muse-code/launcher-") && source.includes("MUSE_SYNC_UPDATE");
      }).pipe(Effect.orElseSucceed(() => false));
      if (!isLauncher) return manual;
      // The launcher has no `update` subcommand. Its documented launch environment
      // forces a synchronous refresh of this executable's own installation.
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: ["--version"],
        updateLockKey: `muse:${context.realCommandPath}`,
        platform: context.platform,
        env: {
          ...makeMuseEnvironment(context.env),
          MUSE_NO_AUTO_UPDATE: "0",
          MUSE_SYNC_UPDATE: "1",
          MUSE_UPDATE_INTERVAL_SECONDS: "0",
        },
      });
      const channel = context.env.MUSE_CHANNEL_URL;
      const channelAssignment = channel
        ? `MUSE_CHANNEL_URL='${channel.replaceAll("'", "'\\''")}' `
        : "";
      return {
        ...capabilities,
        update: capabilities.update
          ? {
              ...capabilities.update,
              command: `${channelAssignment}MUSE_NO_AUTO_UPDATE=0 MUSE_SYNC_UPDATE=1 MUSE_UPDATE_INTERVAL_SECONDS=0 ${capabilities.update.command}`,
            }
          : null,
      };
    }),
};

export const latestMuseVersion = Effect.fn("latestMuseVersion")(function* (
  environment: NodeJS.ProcessEnv,
  options?: { readonly fresh?: boolean },
) {
  const channelUrl = environment.MUSE_CHANNEL_URL || STABLE_CHANNEL_URL;
  const cache = yield* ProviderVersionCache;
  const key = `muse:${channelUrl}`;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = cache.get(key);
  if (!options?.fresh && cached && cached.expiresAt > now) return cached.version;
  const client = yield* HttpClient.HttpClient;
  const version = yield* client.execute(HttpClientRequest.get(channelUrl)).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ChannelManifest)),
            Effect.map((manifest) => parseMuseVersion(manifest.version)),
          )
        : Effect.succeed(null),
    ),
    Effect.timeout(4_000),
    Effect.orElseSucceed(() => null),
  );
  cache.set(key, { version, expiresAt: now + (version === null ? 60_000 : 60 * 60 * 1_000) });
  return version;
});

/** Feed Muse's release channel into the same advisory and notification flow as other drivers. */
export const enrichMuseSnapshot = Effect.fn("enrichMuseSnapshot")(function* (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { snapshot } = input;
  const latestVersion =
    input.enableProviderUpdateChecks && snapshot.enabled && snapshot.installed && snapshot.version
      ? yield* latestMuseVersion(input.environment)
      : null;
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    { ...input.maintenanceCapabilities, latestVersion, compareVersions: compareMuseVersions },
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  );
});
