/**
 * UsageLimitsService - reports subscription rate-window consumption.
 *
 * Where {@link UsageService} answers "what did my sessions cost", this service
 * answers "how close am I to being rate limited". The figures only exist for
 * subscription sign-ins, so each provider read reuses the provider CLI's own
 * credentials: Claude's OAuth grant (credential file under the Claude home,
 * or the macOS login keychain) against Anthropic's OAuth usage endpoint, and
 * Codex's ChatGPT sign-in via a short-lived `codex app-server` asked for
 * `account/rateLimits/read`, and Grok's OIDC sign-in (from `auth.json` under
 * the Grok home) against the Grok CLI backend's billing endpoint, and
 * OpenCode's Zen API key (from `auth.json` under its XDG data dir) against
 * the Zen usage endpoint. API-key auth has no rate windows; those providers
 * answer `unsupported` in-band instead of failing the RPC.
 *
 * @module UsageLimitsService
 */
import * as NodeOS from "node:os";

import {
  USAGE_LIMITS_CONTRACT_VERSION,
  type ProviderUsageLimits,
  type UsageLimitsProviderKind,
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
import * as CodexClient from "effect-codex-app-server/client";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as ServerSettings from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { codexAppServerArgs } from "../provider/Layers/codexLaunchArgs.ts";
import {
  claudePlanLabel,
  parseClaudeOauthCredentials,
  parseClaudeProfileEmail,
  parseClaudeUsageWindows,
} from "./usageLimitsClaude.ts";
import { codexPlanLabel, mapCodexRateLimits, parseCodexAuthKind } from "./usageLimitsCodex.ts";
import {
  grokPlanLabel,
  parseGrokAuthCredentials,
  parseGrokBillingWindows,
  parseGrokUserProfile,
  resolveGrokProxyBaseUrl,
} from "./usageLimitsGrok.ts";
import {
  parseOpenCodeAuthState,
  parseOpenCodeErrorType,
  parseOpenCodeUsageWindows,
} from "./usageLimitsOpenCode.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/** Paths on the Grok CLI's chat proxy; the base URL is resolved per read. */
const GROK_BILLING_PATH = "/billing?format=credits";
const GROK_USER_PATH = "/user?include=subscription";

/** Zen's usage route lives on the console origin, not the inference API. */
const OPENCODE_ZEN_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** The OAuth endpoints require the same beta marker the Claude CLI sends. */
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** The credential payload the CLI stores in the macOS login keychain. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Covers spawning `codex app-server`, the initialize handshake and one read.
 * The probe in CodexProvider budgets similarly for the same round trip.
 */
const CODEX_APP_SERVER_TIMEOUT_MS = 15_000;
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;

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

function makeProviderLimits(provider: UsageLimitsProviderKind) {
  return (
    availability: ProviderUsageLimits["availability"],
    fields: {
      readonly plan?: string | null;
      readonly email?: string | null;
      readonly message?: string | null;
      readonly windows?: ProviderUsageLimits["windows"];
    } = {},
  ): ProviderUsageLimits => ({
    provider,
    availability,
    plan: fields.plan ?? null,
    email: fields.email ?? null,
    windows: fields.windows ?? [],
    message: fields.message ?? null,
  });
}
const claudeLimits = makeProviderLimits("claude");
const codexLimits = makeProviderLimits("codex");
const grokLimits = makeProviderLimits("grok");
const opencodeLimits = makeProviderLimits("opencode");

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

  const claudeOauthRequest = (url: string, accessToken: string) =>
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      }),
    );

  /**
   * Best-effort account email from the OAuth profile endpoint. The email
   * only disambiguates cards; a failure here must never degrade the limit
   * figures, so every failure mode collapses to null.
   */
  const readClaudeProfileEmail = Effect.fn("UsageLimitsService.readClaudeProfileEmail")(
    function* (accessToken: string) {
      const response = yield* httpClient.execute(
        claudeOauthRequest(CLAUDE_PROFILE_URL, accessToken),
      );
      if (response.status < 200 || response.status >= 300) return null;
      const payload = yield* response.json;
      return parseClaudeProfileEmail(payload);
    },
    Effect.timeoutOption(REQUEST_TIMEOUT_MS),
    (effect) =>
      effect.pipe(
        Effect.map((email) => Option.getOrNull(email)),
        Effect.orElseSucceed(() => null),
      ),
  );

  const readClaudeLimits = Effect.fn("UsageLimitsService.readClaudeLimits")(function* () {
    const credentials = yield* readClaudeCredentials();
    if (credentials === null) {
      return claudeLimits("unsupported", { message: SUBSCRIPTION_ONLY_MESSAGE });
    }

    const plan = claudePlanLabel(credentials.subscriptionType);
    const [response, email] = yield* Effect.all(
      [
        httpClient.execute(claudeOauthRequest(CLAUDE_USAGE_URL, credentials.accessToken)).pipe(
          Effect.timeoutOption(REQUEST_TIMEOUT_MS),
          Effect.orElseSucceed(() => Option.none()),
        ),
        readClaudeProfileEmail(credentials.accessToken),
      ],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(response)) {
      return claudeLimits("unavailable", {
        plan,
        email,
        message: "Claude's limit service could not be reached.",
      });
    }
    const status = response.value.status;
    if (status === 401 || status === 403) {
      return claudeLimits("unauthenticated", {
        plan,
        email,
        message:
          "The stored Claude sign-in was rejected. Open Claude Code to refresh it, then retry.",
      });
    }
    if (status < 200 || status >= 300) {
      return claudeLimits("unavailable", {
        plan,
        email,
        message: `Claude's limit service answered with status ${status}.`,
      });
    }

    const payload = yield* response.value.json.pipe(Effect.orElseSucceed(() => null));
    const windows = parseClaudeUsageWindows(payload);
    if (windows.length === 0) {
      return claudeLimits("unavailable", {
        plan,
        email,
        message: "Claude's limit service answered in a shape this version does not understand.",
      });
    }
    return claudeLimits("available", { plan, email, windows });
  });

  /**
   * Spawns a short-lived `codex app-server` and asks it who is signed in and
   * how much of the rate windows is used. No thread is needed: both reads
   * answer right after the initialize handshake. Lifetime is scope-bound; the
   * timeout and force-kill bound a hung binary.
   *
   * The rate-limits read deliberately uses the raw (undecoded) RPC surface:
   * the generated response schema requires integer `usedPercent`s while the
   * wire is known to carry fractional ones, and a decode failure here would
   * misreport a healthy app server as unreachable. `mapCodexRateLimits`
   * parses the raw document defensively instead.
   */
  const requestCodexAccountLimits = Effect.fn("UsageLimitsService.requestCodexAccountLimits")(
    function* (input: {
      readonly binaryPath: string;
      readonly homePath: string | undefined;
      readonly launchArgs: string;
    }) {
      const environment = input.homePath === undefined ? {} : { CODEX_HOME: input.homePath };
      const spawnCommand = yield* resolveSpawnCommand(
        input.binaryPath,
        codexAppServerArgs(input.launchArgs),
        { env: environment, extendEnv: true },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          extendEnv: true,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      );
      const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", {
        clientInfo: { name: "t3code_server", title: "T3 Code", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      yield* client.notify("initialized", undefined);
      const accountResponse = yield* client.request("account/read", {});
      const account = accountResponse.account ?? null;
      const rateLimits =
        account === null && accountResponse.requiresOpenaiAuth
          ? null
          : yield* client.raw.request("account/rateLimits/read", undefined);
      return { account, requiresOpenaiAuth: accountResponse.requiresOpenaiAuth, rateLimits };
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_APP_SERVER_TIMEOUT_MS),
    (effect) =>
      effect.pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      ),
  );

  const readCodexLimits = Effect.fn("UsageLimitsService.readCodexLimits")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings === null) {
      return codexLimits("unavailable", { message: "Server settings could not be read." });
    }
    const codexSettings = settings.providers.codex;
    const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
      Effect.provideService(Path.Path, path),
    );
    // Credentials live in the auth home: the shadow home in authOverlay mode,
    // unlike transcripts, which UsageService reads from the shared home.
    // The file is only a cheap pre-check to skip the spawn for unambiguous
    // API-key auth; a missing file is NOT proof of being signed out, because
    // Codex can keep credentials in the OS keyring or take a key from the
    // environment. The app server is the canonical auth state.
    const authHome = layout.effectiveHomePath ?? layout.sharedHomePath;
    const raw = yield* fileSystem
      .readFileString(path.join(authHome, "auth.json"))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const authKind = raw === null ? "none" : parseCodexAuthKind(raw);
    if (authKind === "apiKey") {
      return codexLimits("unsupported", { message: SUBSCRIPTION_ONLY_MESSAGE });
    }

    const response = yield* requestCodexAccountLimits({
      binaryPath: codexSettings.binaryPath,
      homePath: layout.effectiveHomePath,
      launchArgs: codexSettings.launchArgs,
    });
    if (response === null) {
      // Without local credential evidence, a dead app server most likely
      // means Codex is absent or signed out rather than broken.
      return authKind === "chatgpt"
        ? codexLimits("unavailable", { message: "Codex's app server could not be reached." })
        : codexLimits("unauthenticated", {
            message: "Codex is not signed in on this environment.",
          });
    }
    const account = response.account;
    if (account === null && response.requiresOpenaiAuth) {
      return codexLimits("unauthenticated", {
        message: "Codex is not signed in on this environment.",
      });
    }
    if (account !== null && (account.type === "apiKey" || account.type === "amazonBedrock")) {
      return codexLimits("unsupported", { message: SUBSCRIPTION_ONLY_MESSAGE });
    }

    const chatgptAccount = account !== null && account.type === "chatgpt" ? account : null;
    const rawEmail = chatgptAccount?.email ?? null;
    const email = rawEmail !== null && rawEmail.trim().length > 0 ? rawEmail.trim() : null;
    const { windows, planType } = mapCodexRateLimits(response.rateLimits);
    const plan = codexPlanLabel(planType ?? chatgptAccount?.planType ?? null);
    if (windows.length === 0) {
      return codexLimits("unavailable", {
        plan,
        email,
        message: "Codex answered in a shape this version does not understand.",
      });
    }
    return codexLimits("available", { plan, email, windows });
  });

  const grokRequest = (url: string, key: string) =>
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${key}`,
        accept: "application/json",
      }),
    );

  /**
   * Best-effort plan tier and email from the Grok user endpoint. Identity
   * only; a failure here must never degrade the limit figures.
   */
  const readGrokProfile = Effect.fn("UsageLimitsService.readGrokProfile")(
    function* (input: { readonly baseUrl: string; readonly key: string }) {
      const response = yield* httpClient.execute(
        grokRequest(`${input.baseUrl}${GROK_USER_PATH}`, input.key),
      );
      if (response.status < 200 || response.status >= 300) return parseGrokUserProfile(null);
      const payload = yield* response.json;
      return parseGrokUserProfile(payload);
    },
    Effect.timeoutOption(REQUEST_TIMEOUT_MS),
    (effect) =>
      effect.pipe(
        Effect.map((profile) => Option.getOrNull(profile) ?? parseGrokUserProfile(null)),
        Effect.orElseSucceed(() => parseGrokUserProfile(null)),
      ),
  );

  const readGrokLimits = Effect.fn("UsageLimitsService.readGrokLimits")(function* () {
    // Mirrors the CLI's own auth precedence: an ambient xAI API key wins
    // over the stored sign-in, and API keys have no subscription windows.
    const environment = process.env;
    const apiKey = environment.XAI_API_KEY ?? environment.GROK_CODE_XAI_API_KEY;
    if (apiKey !== undefined && apiKey.trim().length > 0) {
      return grokLimits("unsupported", { message: SUBSCRIPTION_ONLY_MESSAGE });
    }

    // Grok settings do not model a home dir; the CLI's own env overrides are
    // the only relocation mechanism, so honor them the way the CLI would.
    const homeOverride = environment.GROK_HOME?.trim();
    const grokHome =
      homeOverride !== undefined && homeOverride.length > 0
        ? homeOverride
        : path.join(NodeOS.homedir(), ".grok");
    const authPath = environment.GROK_AUTH_PATH?.trim() || path.join(grokHome, "auth.json");
    const raw = yield* fileSystem
      .readFileString(authPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const credentials = raw === null ? null : parseGrokAuthCredentials(raw);
    if (credentials === null) {
      return grokLimits("unauthenticated", {
        message: "Grok is not signed in on this environment.",
      });
    }
    if (credentials.authMode !== "oidc") {
      return grokLimits("unsupported", { message: SUBSCRIPTION_ONLY_MESSAGE });
    }

    // The bearer is scoped to the CLI's configured chat proxy, which team
    // setups override; it must go where the CLI would send it, never to the
    // public default by accident.
    const modelsCacheRaw = yield* fileSystem
      .readFileString(path.join(grokHome, "models_cache.json"))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const baseUrl = resolveGrokProxyBaseUrl({
      envBaseUrl: environment.GROK_CLI_CHAT_PROXY_BASE_URL,
      modelsCacheRaw,
    });
    if (baseUrl === null) {
      return grokLimits("unavailable", {
        message: "Grok's configured proxy endpoint could not be understood.",
      });
    }

    const [response, profile] = yield* Effect.all(
      [
        httpClient.execute(grokRequest(`${baseUrl}${GROK_BILLING_PATH}`, credentials.key)).pipe(
          Effect.timeoutOption(REQUEST_TIMEOUT_MS),
          Effect.orElseSucceed(() => Option.none()),
        ),
        readGrokProfile({ baseUrl, key: credentials.key }),
      ],
      { concurrency: "unbounded" },
    );
    const email = profile.email ?? credentials.email;
    const plan = grokPlanLabel(profile.subscriptionTier);
    if (Option.isNone(response)) {
      return grokLimits("unavailable", {
        plan,
        email,
        message: "Grok's billing service could not be reached.",
      });
    }
    const status = response.value.status;
    if (status === 401 || status === 403) {
      // The CLI's bearer is short-lived (minutes, not days); an expired one
      // is routine rather than a broken login.
      return grokLimits("unauthenticated", {
        plan,
        email,
        message: "The stored Grok sign-in has expired. Use Grok once to refresh it, then retry.",
      });
    }
    if (status < 200 || status >= 300) {
      return grokLimits("unavailable", {
        plan,
        email,
        message: `Grok's billing service answered with status ${status}.`,
      });
    }

    const payload = yield* response.value.json.pipe(Effect.orElseSucceed(() => null));
    const windows = parseGrokBillingWindows(payload);
    if (windows.length === 0) {
      return grokLimits("unavailable", {
        plan,
        email,
        message: "Grok's billing service answered in a shape this version does not understand.",
      });
    }
    return grokLimits("available", { plan, email, windows });
  });

  /**
   * Finds the CLI's Zen API key, or the fact that OpenCode is signed in only
   * to pass-through providers, or null when there is no sign-in at all.
   * Mirrors the CLI's own precedence: an ambient key wins, then the injected
   * auth document, then `auth.json` under the XDG data dir.
   */
  const readOpenCodeAuthState = Effect.fn("UsageLimitsService.readOpenCodeAuthState")(function* () {
    const environment = process.env;
    const envKey = environment.OPENCODE_API_KEY?.trim();
    if (envKey !== undefined && envKey.length > 0) {
      return { kind: "zen", key: envKey } as const;
    }
    const injected = environment.OPENCODE_AUTH_CONTENT;
    if (injected !== undefined && injected.trim().length > 0) {
      const state = parseOpenCodeAuthState(injected);
      if (state !== null) return state;
    }

    // OpenCode settings do not model a home dir; the CLI resolves its data
    // dir through xdg-basedir on every platform, so honor the same override.
    const xdgData = environment.XDG_DATA_HOME?.trim();
    const dataDir =
      xdgData !== undefined && xdgData.length > 0
        ? xdgData
        : path.join(NodeOS.homedir(), ".local", "share");
    const raw = yield* fileSystem
      .readFileString(path.join(dataDir, "opencode", "auth.json"))
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    return raw === null ? null : parseOpenCodeAuthState(raw);
  });

  const readOpenCodeLimits = Effect.fn("UsageLimitsService.readOpenCodeLimits")(function* () {
    const auth = yield* readOpenCodeAuthState();
    if (auth === null) {
      return opencodeLimits("unauthenticated", {
        message: "OpenCode is not signed in on this environment.",
      });
    }
    if (auth.kind !== "zen") {
      return opencodeLimits("unsupported", {
        message:
          "OpenCode is signed in through other providers here; those report their own limits. Zen windows only exist for an OpenCode Zen sign-in.",
      });
    }

    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(OPENCODE_ZEN_USAGE_URL).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${auth.key}`,
            accept: "application/json",
          }),
        ),
      )
      .pipe(
        Effect.timeoutOption(REQUEST_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none()),
      );
    if (Option.isNone(response)) {
      return opencodeLimits("unavailable", {
        message: "OpenCode Zen's usage service could not be reached.",
      });
    }
    const status = response.value.status;
    if (status === 401) {
      return opencodeLimits("unauthenticated", {
        message:
          "The stored OpenCode Zen key was rejected. Sign in with opencode again, then retry.",
      });
    }
    if (status === 403) {
      // Zen answers 403 EntitlementError for keys on pay-as-you-go credits:
      // a valid sign-in, but with no subscription windows to report.
      const body = yield* response.value.json.pipe(Effect.orElseSucceed(() => null));
      return parseOpenCodeErrorType(body) === "EntitlementError"
        ? opencodeLimits("unsupported", { message: SUBSCRIPTION_ONLY_MESSAGE })
        : opencodeLimits("unauthenticated", {
            message:
              "The stored OpenCode Zen key was rejected. Sign in with opencode again, then retry.",
          });
    }
    if (status < 200 || status >= 300) {
      return opencodeLimits("unavailable", {
        message: `OpenCode Zen's usage service answered with status ${status}.`,
      });
    }

    const payload = yield* response.value.json.pipe(Effect.orElseSucceed(() => null));
    const windows = parseOpenCodeUsageWindows(payload);
    if (windows.length === 0) {
      return opencodeLimits("unavailable", {
        message:
          "OpenCode Zen's usage service answered in a shape this version does not understand.",
      });
    }
    return opencodeLimits("available", { plan: "OpenCode Go", windows });
  });

  const readLimits = Effect.fn("UsageLimitsService.readLimits")(function* () {
    const [claude, codex, grok, opencode] = yield* Effect.all(
      [readClaudeLimits(), readCodexLimits(), readGrokLimits(), readOpenCodeLimits()],
      { concurrency: "unbounded" },
    );
    const readAt = yield* DateTime.now;
    return {
      contractVersion: USAGE_LIMITS_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      providers: [claude, codex, grok, opencode],
    } satisfies UsageLimitsSummary;
  });

  return { readLimits } as const;
});

export const layer = Layer.effect(UsageLimitsService, make);
