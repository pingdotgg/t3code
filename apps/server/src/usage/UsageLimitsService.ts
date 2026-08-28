/**
 * UsageLimitsService - reports subscription rate-window consumption.
 *
 * Where {@link UsageService} answers "what did my sessions cost", this service
 * answers "how close am I to being rate limited". The figures only exist for
 * subscription sign-ins, so the service reuses the provider CLI's own OAuth
 * grant (credential file under the Claude home, or the macOS login keychain)
 * and asks Anthropic's OAuth usage endpoint. API-key auth has no rate
 * windows; those environments answer `unsupported` in-band instead of
 * failing the RPC.
 *
 * @module UsageLimitsService
 */
import {
  USAGE_LIMITS_CONTRACT_VERSION,
  type ProviderUsageLimits,
  type UsageLimitsSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerSettings from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  claudePlanLabel,
  parseClaudeOauthCredentials,
  parseClaudeUsageWindows,
} from "./usageLimitsClaude.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The OAuth endpoints require the same beta marker the Claude CLI sends. */
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** The credential payload the CLI stores in the macOS login keychain. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const REQUEST_TIMEOUT_MS = 10_000;

const SUBSCRIPTION_ONLY_MESSAGE =
  "Limit info is only available for subscription sign-ins. API usage is billed per token and has no rate windows.";

export class UsageLimitsService extends Context.Service<
  UsageLimitsService,
  {
    readonly readLimits: () => Effect.Effect<UsageLimitsSummary>;
  }
>()("t3/usage/UsageLimitsService") {}

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageLimitsService,
  UsageLimitsService.of({
    readLimits: () =>
      Effect.succeed({
        contractVersion: USAGE_LIMITS_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        providers: [],
      }),
  }),
);

function claudeLimits(
  availability: ProviderUsageLimits["availability"],
  plan: string | null,
  message: string | null,
  windows: ProviderUsageLimits["windows"] = [],
): ProviderUsageLimits {
  return { provider: "claude", availability, plan, windows, message };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;

  /**
   * Reads the CLI's keychain entry. The CLI only writes it on macOS; elsewhere
   * (and when the entry is absent or access is denied) this yields null.
   */
  const readMacKeychainCredentials = Effect.fn("UsageLimitsService.readMacKeychainCredentials")(
    function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("security", [
          "find-generic-password",
          "-s",
          CLAUDE_KEYCHAIN_SERVICE,
          "-w",
        ]),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, exitCode] = yield* Effect.all(
        [collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }), child.exitCode],
        { concurrency: "unbounded" },
      );
      const text = stdout.text.trim();
      return Number(exitCode) === 0 && text.length > 0 ? text : null;
    },
    Effect.scoped,
    Effect.timeoutOption(5_000),
    (effect) =>
      effect.pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      ),
  );

  /**
   * Finds the OAuth grant the CLI signed in with, or null when there is none
   * (not signed in, or authenticated with an API key). Mirrors the CLI's own
   * storage order: credential file under the Claude home first, then the
   * macOS login keychain.
   */
  const readClaudeCredentials = Effect.fn("UsageLimitsService.readClaudeCredentials")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings === null) return null;

    const home = yield* resolveClaudeHomePath(settings.providers.claudeAgent).pipe(
      Effect.provideService(Path.Path, path),
    );
    // The configured home is either the user home (default install nests
    // under `.claude`) or the config dir itself, mirroring the transcript
    // probe in UsageService.
    const candidates = [
      path.join(home, ".claude", ".credentials.json"),
      path.join(home, ".credentials.json"),
    ];
    for (const candidate of candidates) {
      const raw = yield* fileSystem
        .readFileString(candidate)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (raw === null) continue;
      const parsed = parseClaudeOauthCredentials(raw);
      if (parsed !== null) return parsed;
    }

    if (platform === "darwin") {
      const raw = yield* readMacKeychainCredentials();
      if (raw !== null) return parseClaudeOauthCredentials(raw);
    }
    return null;
  });

  const readClaudeLimits = Effect.fn("UsageLimitsService.readClaudeLimits")(function* () {
    const credentials = yield* readClaudeCredentials();
    if (credentials === null) {
      return claudeLimits("unsupported", null, SUBSCRIPTION_ONLY_MESSAGE);
    }

    const plan = claudePlanLabel(credentials.subscriptionType);
    const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      }),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(response)) {
      return claudeLimits("unavailable", plan, "Claude's limit service could not be reached.");
    }
    const status = response.value.status;
    if (status === 401 || status === 403) {
      return claudeLimits(
        "unauthenticated",
        plan,
        "The stored Claude sign-in was rejected. Open Claude Code to refresh it, then retry.",
      );
    }
    if (status < 200 || status >= 300) {
      return claudeLimits(
        "unavailable",
        plan,
        `Claude's limit service answered with status ${status}.`,
      );
    }

    const payload = yield* response.value.json.pipe(Effect.orElseSucceed(() => null));
    const windows = parseClaudeUsageWindows(payload);
    if (windows.length === 0) {
      return claudeLimits(
        "unavailable",
        plan,
        "Claude's limit service answered in a shape this version does not understand.",
      );
    }
    return claudeLimits("available", plan, null, windows);
  });

  const readLimits = Effect.fn("UsageLimitsService.readLimits")(function* () {
    const claude = yield* readClaudeLimits();
    const readAt = yield* DateTime.now;
    return {
      contractVersion: USAGE_LIMITS_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      providers: [claude],
    } satisfies UsageLimitsSummary;
  });

  return { readLimits } as const;
});

export const layer = Layer.effect(UsageLimitsService, make);
