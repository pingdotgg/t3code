import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";

const DRIVER = ProviderDriverKind.make("muse");
/** Mirrors the official launcher, which reads MUSE_CHANNEL and accepts only these two. */
const MUSE_CHANNELS = new Set(["muse-stable", "muse-canary"]);
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

const MUSE_REVISION = /-R\d+(?:\.\d+)?$/;

/** A version printed without a revision is compared by its release alone. */
export const compareMuseVersions = (current: string, latest: string) =>
  MUSE_REVISION.test(current) === MUSE_REVISION.test(latest)
    ? compareSemverVersions(comparableMuseVersion(current), comparableMuseVersion(latest))
    : compareSemverVersions(current.replace(MUSE_REVISION, ""), latest.replace(MUSE_REVISION, ""));

/** Only the official launcher owns an update channel; a standalone binary cannot update itself. */
export const museMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.gen(function* () {
      const manual = {
        ...makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
        compareVersions: compareMuseVersions,
      };
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
      const updateEnv = {
        ...(context.env.MUSE_CHANNEL ? { MUSE_CHANNEL: context.env.MUSE_CHANNEL } : {}),
        MUSE_NO_AUTO_UPDATE: "0",
        MUSE_SYNC_UPDATE: "1",
        MUSE_UPDATE_INTERVAL_SECONDS: "0",
      };
      return {
        ...makeProviderMaintenanceCapabilities({
          provider: DRIVER,
          packageName: null,
          updateExecutable: context.resolvedCommandPath,
          updateArgs: ["--version"],
          updateCommand: [
            ...Object.entries(updateEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
            shellQuote(context.resolvedCommandPath),
            "--version",
          ].join(" "),
          updateLockKey: `muse:${context.realCommandPath}`,
          platform: context.platform,
          env: { ...context.env, ...updateEnv },
        }),
        compareVersions: compareMuseVersions,
      };
    }),
};

function shellQuote(word: string) {
  return /^[\w./:@=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export const latestMuseVersion = Effect.fn("latestMuseVersion")(function* (
  environment: NodeJS.ProcessEnv,
  options?: { readonly fresh?: boolean },
) {
  const channel = environment.MUSE_CHANNEL || "muse-stable";
  if (!MUSE_CHANNELS.has(channel)) return null;
  const channelUrl = `https://api.meta.ai/muse-code/channels/${channel}`;
  const client = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  return yield* latestVersions.cached(
    `muse:${channelUrl}`,
    client.execute(HttpClientRequest.get(channelUrl)).pipe(
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
    ),
    options,
  );
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
    { ...input.maintenanceCapabilities, latestVersion },
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  );
});
