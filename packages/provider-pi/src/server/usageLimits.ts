import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import {
  AUTH_PROBE_TIMEOUT_MS,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";

import type { PiSettings } from "../settings.ts";

/** `pi auth print-bearer-token` arrived in Pi 0.83.0. */
const PI_BEARER_TOKEN_VERSION = "0.83.0";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Pi's error when Anthropic uses an API key, or no credential at all.
const NO_OAUTH_TOKEN = "not configured with an OAuth bearer token";

const UsageWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
});
const AnthropicUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(UsageWindow)),
  seven_day: Schema.optional(Schema.NullOr(UsageWindow)),
});

const WINDOWS = [
  { key: "five_hour", kind: "session", label: "Claude · Session", windowDurationMins: 5 * 60 },
  { key: "seven_day", kind: "weekly", label: "Claude · Weekly", windowDurationMins: 7 * 24 * 60 },
] as const;

export function supportsPiAnthropicUsageLimits(version: string | null): boolean {
  return version !== null && compareSemverVersions(version, PI_BEARER_TOKEN_VERSION) >= 0;
}

/**
 * Reads the Claude subscription limits behind Pi's Anthropic sign-in. Pi prints the token and
 * refreshes it under its own lock, so T3 never rotates Pi's credentials. Undefined means Pi has
 * no Anthropic subscription sign-in, so there are no limits to show.
 */
export const readPiAnthropicUsageLimits = Effect.fn("PiUsageLimits.readAnthropic")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });
  const command = settings.binaryPath || "pi";
  const env = providerProbeEnvironment(environment);
  const tokenOutput = yield* resolveSpawnCommand(
    command,
    ["auth", "print-bearer-token", "--provider", "anthropic", "--min-expiry", "5m"],
    { env },
  ).pipe(
    Effect.flatMap((spawnCommand) =>
      spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env,
          shell: spawnCommand.shell,
        }),
      ),
    ),
    Effect.timeout(resolveProviderProbeTimeoutMs("pi", AUTH_PROBE_TIMEOUT_MS, environment)),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
  if (tokenOutput?.stderr.includes(NO_OAUTH_TOKEN)) return undefined;
  const token = tokenOutput?.code === 0 ? tokenOutput.stdout.trim() : "";
  if (!token) {
    return probeFailed("Pi could not provide its Claude sign-in. Run `pi` and use /login.");
  }

  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const usage = yield* client
      .execute(
        HttpClientRequest.get(ANTHROPIC_USAGE_URL).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AnthropicUsage)),
      );
    const windows: ServerProviderUsageWindow[] = [];
    for (const { key, ...window } of WINDOWS) {
      const reading = usage[key];
      if (typeof reading?.utilization !== "number") continue;
      const resetsAt = reading.resets_at ? DateTime.make(reading.resets_at) : Option.none();
      windows.push({
        id: `anthropic_${key}`,
        ...window,
        // Pi model slugs are `provider/model`; these limits bind only Anthropic's models.
        providerIds: ["anthropic"],
        usedPercent: clampPercent(reading.utilization),
        ...(Option.isSome(resetsAt) ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
      });
    }
    return makeUsageLimits({ checkedAt, windows }) satisfies ServerProviderUsageLimits;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => probeFailed("Could not read Claude usage limits.")),
  );
});
