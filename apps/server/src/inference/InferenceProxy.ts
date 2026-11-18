import {
  EnvironmentId,
  defaultInstanceIdForDriver,
  managedCapabilityDenial,
  managedUpdatesDenial,
  ProviderDriverKind,
  INFERENCE_DRIVERS,
  INFERENCE_HARNESSES,
  inferenceHarness,
  InferenceConsumer,
  type InferenceGrantInput,
  InferenceRouteHealth,
  InferenceDriver,
  TRAEX_BRIDGE_INSTANCE_ID,
  type InferenceProviderConfig,
  InferenceHostConnection,
  isInferenceProviderConfig,
  isInferenceRoutingEnabled,
  InferenceRouting,
  defaultInferenceRouting,
  InferenceProxyError,
  ProviderInstanceId,
  isManagedDriverAllowed,
  type InferenceProxyAction,
  type InferenceProxyActionResult,
  type InferenceProxyStatus,
  type InferenceRouteGrant,
  type InferenceRouteInput,
  type InferenceUpstream,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { NetService } from "@t3tools/shared/Net";
import { isProviderInstanceEnabledInAnyScope } from "@t3tools/shared/serverSettings";
import { readTailscaleServeRoutesTo } from "@t3tools/tailscale";
import * as Arr from "effect/Array";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Cache from "effect/Cache";
import * as Digest from "effect/crypto/Digest";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { DirectEndpoints } from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as ManagedProviders from "../policy/managedProviders.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { claudeKeychainEntry } from "./claudeKeychain.ts";
import { install, proxyVersion, resolveRelease, Release } from "./install.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  inferenceRetryDelayMs,
  isRetryableInferenceStatus,
  modelsForDriver,
  needsAccountModelLookup,
  openCodeRouteProblem,
  validateRouteUrl,
} from "./routes.ts";
import { directTraexBridge, readCodexEndpointModels } from "../provider/codexEndpointModels.ts";
import { TRAEX_CONSUMER_SECRET, TRAEX_HOST_PATH, traexConsumerRouteKey } from "./traex.ts";
import * as TraexProviderRoutes from "./TraexProviderRoutes.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";

const SavedRouteHost = Schema.Struct({
  hostId: EnvironmentId,
  baseUrl: Schema.String,
  key: Schema.String,
  connection: Schema.optionalKey(InferenceHostConnection),
});
const SavedRouteCandidate = Schema.Struct({
  ...SavedRouteHost.fields,
  models: Schema.Array(Schema.String),
});
type SavedRouteCandidate = typeof SavedRouteCandidate.Type;
const Saved = Schema.Struct({
  enabled: Schema.Boolean,
  sharing: Schema.Boolean,
  port: Schema.Int,
  routing: Schema.optionalKey(InferenceRouting),
  release: Schema.optionalKey(Release),
  revokedConsumers: Schema.optionalKey(Schema.Array(EnvironmentId)),
  grants: Schema.Array(
    Schema.Struct({
      ...InferenceConsumer.fields,
      key: Schema.String,
      traexKey: Schema.optionalKey(Schema.String),
    }),
  ),
  traexHosts: Schema.optionalKey(Schema.Array(SavedRouteHost)),
  routePools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        driver: InferenceDriver,
        primary: SavedRouteCandidate,
        alternates: Schema.Array(SavedRouteCandidate),
      }),
    ),
  ),
  // Local CLI sign-ins the user removed from the pool; the sync must not bring them back.
  removedLocalAccounts: Schema.optionalKey(Schema.Array(Schema.String)),
});
type Saved = typeof Saved.Type;
const REQUEST_SYNC_INTERVAL_MS = 60_000;
const empty: Saved = { enabled: false, sharing: false, port: 0, grants: [] };
const Files = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      auth_index: Schema.optionalKey(Schema.String),
      name: Schema.String,
      provider: Schema.String,
      status: Schema.String,
      disabled: Schema.optionalKey(Schema.Boolean),
      unavailable: Schema.optionalKey(Schema.Boolean),
      status_message: Schema.optionalKey(Schema.NullOr(Schema.String)),
      next_retry_after: Schema.optionalKey(Schema.NullOr(Schema.String)),
      runtime_only: Schema.optionalKey(Schema.Boolean),
      cooldowns: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              scope: Schema.String,
              model_key: Schema.optionalKey(Schema.String),
              retry_at: Schema.String,
            }),
          ),
        ),
      ),
    }),
  ),
});
const Peer = Schema.Struct({ environmentId: EnvironmentId });
const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, owned_by: Schema.optional(Schema.String) }),
  ),
});
const AccountModels = Schema.Struct({ models: Schema.Array(Schema.Struct({ id: Schema.String })) });
// Local CLI sign-ins T3 mirrors into the pool, keyed the way `removedLocalAccounts` records them.
const LOCAL_ACCOUNT_PREFIX: Partial<Record<InferenceUpstream, string>> = {
  codex: "codex:",
  anthropic: "claude:",
};
const Login = Schema.Struct({ state: Schema.String, url: Schema.String });
const AuthStatus = Schema.Struct({ status: Schema.Literals(["ok", "error", "wait"]) });
const UploadStatus = Schema.Struct({ status: Schema.Literal("ok") });
const LocalCodexAuth = Schema.Struct({
  auth_mode: Schema.Literal("chatgpt"),
  last_refresh: Schema.String,
  tokens: Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    id_token: Schema.String,
    account_id: Schema.String,
  }),
});
const ProxyCodexAuth = Schema.Struct({
  type: Schema.Literal("codex"),
  account_id: Schema.String,
  last_refresh: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  id_token: Schema.String,
  disabled: Schema.optionalKey(Schema.Boolean),
});
const LocalClaudeAuth = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
});
const ClaudeAccount = Schema.Struct({
  oauthAccount: Schema.Struct({
    accountUuid: Schema.String,
    organizationUuid: Schema.String,
    emailAddress: Schema.String,
    organizationName: Schema.optionalKey(Schema.String),
  }),
});
const ProxyClaudeAuth = Schema.Struct({
  type: Schema.Literal("claude"),
  account_uuid: Schema.String,
  organization_uuid: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  expired: Schema.String,
  disabled: Schema.optionalKey(Schema.Boolean),
});
const isLocalCodexAuth = Schema.is(LocalCodexAuth);
const isProxyCodexAuth = Schema.is(ProxyCodexAuth);
const isLocalClaudeAuth = Schema.is(LocalClaudeAuth);
const isClaudeAccount = Schema.is(ClaudeAccount);
const isProxyClaudeAuth = Schema.is(ProxyClaudeAuth);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function accountAvailability(account: (typeof Files.Type)["files"][number]) {
  if (account.disabled) return "disabled" as const;
  if (account.status === "active" && !account.unavailable) return "available" as const;
  const reason = account.status_message ?? "";
  if (
    /\b(?:401|403)\b|auth(?:entication)?[_ -]?fail|invalid[_ -]?grant|invalid[_ -]?credential/i.test(
      reason,
    )
  )
    return "authenticationError" as const;
  if (/\b(?:408|5\d\d)\b|service[_ -]?overloaded|overload|transient/i.test(reason))
    return "unavailable" as const;
  if (/\b429\b|rate[_ -]?limit|quota|exhausted/i.test(reason)) return "rateLimited" as const;
  return "unavailable" as const;
}

interface ClaudeUsageCacheKey {
  readonly baseUrl: string;
  readonly management: string;
  readonly id: string;
  readonly authIndex: string;
}
interface AccountModelsCacheKey {
  readonly baseUrl: string;
  readonly management: string;
  readonly id: string;
}

function availableDrivers(files: (typeof Files.Type)["files"]) {
  const available = files.filter(
    (account) => account.status === "active" && !account.disabled && !account.unavailable,
  );
  return INFERENCE_DRIVERS.filter((driver) =>
    available.some(
      (account) => INFERENCE_HARNESSES[driver].accounts?.includes(account.provider) ?? true,
    ),
  );
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

function codexAccountIdentity(accountId: string, email: unknown) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : undefined;
  return normalized?.includes("@") ? `codex:${accountId}:${normalized}` : undefined;
}

function proxyCodexEmail(account: typeof ProxyCodexAuth.Type & { readonly email?: unknown }) {
  return typeof account.email === "string" && account.email.includes("@")
    ? account.email
    : jwtClaims(account.id_token)?.email;
}

function parseLocalCodexAuth(raw: string) {
  const decoded = decodeUnknownJson(raw);
  if (Option.isNone(decoded)) return null;
  const parsed = decoded.value;
  if (!isRecord(parsed) || !isLocalCodexAuth(parsed)) return null;
  const { tokens, last_refresh: lastRefresh } = parsed;
  const expiresAt = jwtClaims(tokens.access_token)?.exp;
  const refreshedAt = Date.parse(lastRefresh);
  if (
    !tokens.account_id ||
    !tokens.access_token ||
    !tokens.refresh_token ||
    !tokens.id_token ||
    !Number.isFinite(refreshedAt)
  )
    return null;
  return { data: parsed, tokens, lastRefresh, refreshedAt, expiresAt };
}
const failure = (message: string) => new InferenceProxyError({ message });
const isInferenceFailure = Schema.is(InferenceProxyError);
const decodeSaved = Schema.decodeEffect(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeEffect(Schema.fromJsonString(Saved));
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const safeFailure = (message: string) => (cause: unknown) =>
  isInferenceFailure(cause) ? cause : failure(message);

const providerConfig = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const newKey = random
    .randomBytes(32)
    .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("base64url")));
  const jsonRequest = Effect.fn("InferenceProxy.request")(
    function* <A>(
      url: string,
      key: string | undefined,
      schema: Schema.Decoder<A>,
      method: HttpMethod.HttpMethod = "GET",
      body?: object,
    ) {
      let request = HttpClientRequest.make(method)(url);
      if (key !== undefined)
        request = HttpClientRequest.setHeader(request, "authorization", "Bearer " + key);
      if (body) request = yield* HttpClientRequest.bodyJson(request, body);
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300)
        return yield* failure(`CLIProxyAPI returned HTTP ${response.status}.`);
      return yield* Schema.decodeEffect(schema)(yield* response.json);
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("10 seconds"),
    Effect.mapError(safeFailure("Could not reach CLIProxyAPI or decode its response.")),
  );
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceScope = yield* Scope.Scope;
  const cliproxy = yield* makeCliproxyApi;
  const quotaSemaphore = yield* Semaphore.make(4);
  const claudeUsageCache = yield* Cache.make({
    capacity: 128,
    timeToLive: "30 seconds",
    lookup: Effect.fn("InferenceProxy.readClaudeUsage")(function* (key: ClaudeUsageCacheKey) {
      return yield* cliproxy
        .readClaudeUsage(
          { url: key.baseUrl, managementKey: key.management },
          { id: key.id, auth_index: key.authIndex },
        )
        .pipe(
          quotaSemaphore.withPermits(1),
          Effect.orElseSucceed(() => undefined),
        );
    }),
  });
  const modelLookupSemaphore = yield* Semaphore.make(4);
  const accountModelsCache = yield* Cache.make({
    capacity: 128,
    timeToLive: "30 seconds",
    lookup: Effect.fn("InferenceProxy.readAccountModels")(function* (key: AccountModelsCacheKey) {
      return yield* jsonRequest(
        key.baseUrl + "/v0/management/auth-files/models?name=" + encodeURIComponent(key.id),
        key.management,
        AccountModels,
      ).pipe(
        modelLookupSemaphore.withPermits(1),
        Effect.orElseSucceed(() => undefined),
      );
    }),
  });
  const cachedResults = Effect.fn("InferenceProxy.cachedResults")(function* <K, A>(
    cache: Cache.Cache<K, A>,
    keys: readonly K[],
    wait?: Duration.Input,
  ) {
    yield* Effect.forEach(keys, (key) =>
      Effect.gen(function* () {
        if (!(yield* Cache.has(cache, key)))
          yield* Cache.get(cache, key).pipe(Effect.ignore, Effect.forkIn(serviceScope));
      }),
    );
    if (wait !== undefined && keys.length)
      yield* Effect.forEach(keys, (key) => Cache.get(cache, key), {
        concurrency: "unbounded",
      }).pipe(Effect.timeout(wait), Effect.ignore);
    return yield* Effect.forEach(keys, (key) => Cache.getSuccess(cache, key));
  });
  const net = yield* NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const matchesRouteKey = Effect.fn("InferenceProxy.matchesRouteKey")(function* (
    instanceId: ProviderInstanceId,
    storedKey: InferenceProviderConfig["inferenceKey"],
    expected: string,
  ) {
    if (storedKey !== SECRET_REDACTED) return storedKey === expected;
    const current = (yield* settings.getSettings).providerInstances[instanceId]?.config;
    return isInferenceProviderConfig(current) && current.inferenceKey === expected;
  });
  const registry = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const links = yield* PeerLinks.PeerLinks;
  const direct = yield* DirectEndpoints;
  const env = yield* HostProcess.Environment;
  const providerEnvironment = ManagedProviders.providerHostEnvironment(settings.managedPolicy, env);
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const username = yield* HostProcess.Username;
  const traexRoutes = yield* TraexProviderRoutes.TraexProviderRoutes;
  const bridgeContext = yield* Effect.context<Effect.Services<typeof directTraexBridge>>();
  const localBridge = directTraexBridge.pipe(Effect.provide(bridgeContext));
  const bridgeModels = yield* Cache.make({
    capacity: 64,
    timeToLive: "5 seconds",
    lookup: ({ baseUrl, key }: { baseUrl: string; key: string }) =>
      readCodexEndpointModels(baseUrl + "/v1/models", key).pipe(
        Effect.map((models) => models.map((model) => model.slug)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.orElseSucceed(() => [] as readonly string[]),
      ),
  });
  const localBridgeTarget = Effect.gen(function* () {
    const bridge = yield* localBridge;
    if (!bridge) return undefined;
    return { baseUrl: new URL(bridge.baseUrl).origin, key: bridge.key };
  });
  const localTraexAvailable = Effect.gen(function* () {
    const target = yield* localBridgeTarget;
    return target !== undefined && (yield* Cache.get(bridgeModels, target)).length > 0;
  });
  const sharingDenial = managedCapabilityDenial(settings.managedPolicy, "remoteClients");
  const installContext = yield* Effect.context<Effect.Services<ReturnType<typeof install>>>();
  const latest = yield* Effect.cachedWithTTL(
    resolveRelease(undefined).pipe(Effect.provide(installContext)),
    (exit) => (Exit.isSuccess(exit) ? "15 minutes" : 0),
  );
  const mutex = yield* Semaphore.make(1);
  const updateMutex = yield* Semaphore.make(1);
  const catalogMutex = yield* Semaphore.make(1);
  const children = yield* Queue.sliding<ChildProcessSpawner.ChildProcessHandle>(1);
  const directory = path.join(config.stateDir, "inference-proxy");
  const localCodexHome = path.resolve(
    expandHomePath(env.CODEX_HOME?.trim() || "~/.codex", homeDirectory),
  );
  const localCodexAuthPath = path.join(localCodexHome, "auth.json");
  const localClaudeHome = path.resolve(
    expandHomePath(env.CLAUDE_CONFIG_DIR?.trim() || "~/.claude", homeDirectory),
  );
  const localClaudeAuthPath = path.join(localClaudeHome, ".credentials.json");
  const localClaudeAccountPath = path.join(
    env.CLAUDE_CONFIG_DIR?.trim() ? localClaudeHome : homeDirectory,
    ".claude.json",
  );
  let cached: Saved | undefined;
  let proxyAccountWatch: Fiber.Fiber<void> | undefined;
  let lastRequestSync = Number.NEGATIVE_INFINITY;
  const routeFailures = new Map<string, number>();
  let running:
    | {
        child: ChildProcessSpawner.ChildProcessHandle;
        file: string;
        port: number;
        scope: Scope.Closeable;
        baseUrl: string;
        key: string;
        management: string;
      }
    | undefined;
  const claudeUsageEvidence = Effect.fn("InferenceProxy.claudeUsageEvidence")(function* (
    runtime: NonNullable<typeof running>,
    files: (typeof Files.Type)["files"],
    waitForUsage: boolean,
  ) {
    const eligible = files
      .filter(
        (file) =>
          file.provider === "claude" &&
          file.status === "active" &&
          !file.disabled &&
          !file.unavailable &&
          !file.runtime_only &&
          !!file.id &&
          !!file.auth_index,
      )
      .slice(0, 128);
    const keys: ClaudeUsageCacheKey[] = eligible.map((file) => ({
      baseUrl: runtime.baseUrl,
      management: runtime.management,
      id: file.id!,
      authIndex: file.auth_index!,
    }));
    const results = yield* cachedResults(
      claudeUsageCache,
      keys,
      waitForUsage ? "2 seconds" : undefined,
    );
    const now = yield* Clock.currentTimeMillis;
    const evidence = new Map<string, string>();
    for (const [index, file] of eligible.entries()) {
      const cached = results[index]!;
      if (Option.isNone(cached) || !cached.value || cached.value.unavailable) continue;
      if (
        cached.value.windows.some(
          (window) => window.id === "monthly_spend" && window.usedPercent < 100,
        )
      )
        continue;
      const resets = cached.value.windows
        .filter(
          (window) =>
            (window.id === "five_hour" || window.id === "seven_day") &&
            window.usedPercent >= 100 &&
            window.resetsAt &&
            Date.parse(window.resetsAt) > now,
        )
        .map((window) => Date.parse(window.resetsAt!));
      if (resets.length)
        evidence.set(file.name, DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))));
    }
    return evidence;
  });
  const read = Effect.gen(function* () {
    if (cached) return cached;
    const raw = yield* store.get("inference-proxy-state");
    cached = Option.isSome(raw) ? yield* decodeSaved(new TextDecoder().decode(raw.value)) : empty;
    return cached;
  });
  const save = Effect.fn("InferenceProxy.save")(function* (next: Saved) {
    const state = running ? { ...next, port: running.port } : next;
    yield* store.set("inference-proxy-state", new TextEncoder().encode(yield* encodeSaved(state)));
    cached = state;
  }, Effect.uninterruptible);
  const stop = Effect.gen(function* () {
    if (running) yield* Scope.close(running.scope, Exit.void);
    running = undefined;
  });
  yield* Effect.addFinalizer(() => stop);
  const writeConfig = Effect.fn("InferenceProxy.writeConfig")(function* (
    routing: NonNullable<Saved["routing"]>,
    runtime: Pick<NonNullable<typeof running>, "file" | "port" | "key" | "management">,
  ) {
    const authDir = path.join(directory, "accounts");
    yield* fs.makeDirectory(authDir, { recursive: true, mode: 0o700 });
    yield* writeFileStringAtomically({
      filePath: runtime.file,
      contents: yield* encodeConfig({
        "config-version": 8,
        server: {
          host: "127.0.0.1",
          port: runtime.port,
          "max-request-body-bytes": 64 * 1024 * 1024,
        },
        oauth: { "auth-dir": authDir },
        access: { "api-keys": [runtime.key] },
        requests: { "passthrough-headers": true },
        management: {
          "allow-remote": false,
          "secret-key": runtime.management,
          "disable-control-panel": true,
        },
        routing: { strategy: routing.strategy, "session-affinity": routing.sessionAffinity },
      }),
      mode: 0o600,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });
  const ensure = Effect.fn("InferenceProxy.start")(function* (state: Saved) {
    if (!state.enabled)
      return yield* failure("Enable inference hosting on this environment first.");
    if (running && (yield* running.child.isRunning)) return running;
    yield* stop;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const executable = yield* install(directory, state.release).pipe(
      Effect.provide(installContext),
      Effect.mapError(
        safeFailure(
          "Could not install the pinned CLIProxyAPI release. Check network access and retry.",
        ),
      ),
    );
    const key = Buffer.from(yield* store.getOrCreateRandom("inference-proxy-local", 32)).toString(
      "base64url",
    );
    const management = yield* newKey;
    const port = yield* net.findAvailablePort(state.port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const scope = yield* Scope.make();
    return yield* Effect.gen(function* () {
      // A surviving sidecar watches its config and must never reload the next child's credentials.
      const configDir = yield* fs
        .makeTempDirectoryScoped({ directory, prefix: "runtime-config-" })
        .pipe(Scope.provide(scope));
      const file = path.join(configDir, "config.yaml");
      const runtime = { file, port, key, management, baseUrl };
      yield* writeConfig(state.routing ?? defaultInferenceRouting, runtime);
      const child = yield* spawner
        .spawn(
          ChildProcess.make(executable, ["-config", file, "-local-model"], {
            cwd: directory,
            env: {
              HOME: directory,
              USERPROFILE: directory,
              PATH: env.PATH,
              SystemRoot: env.SystemRoot,
              TEMP: env.TEMP,
              TMP: env.TMP,
              SSL_CERT_FILE: env.SSL_CERT_FILE,
            },
            extendEnv: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(Scope.provide(scope));
      yield* jsonRequest(baseUrl + "/v0/management/auth-files", management, Files).pipe(
        Effect.retry({ times: 40, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("8 seconds"),
      );
      const saved = yield* read;
      if (saved.enabled && saved.port !== port) yield* save({ ...saved, port });
      running = { ...runtime, child, scope };
      yield* Queue.offer(children, child);
      return running;
    }).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)),
    );
  });

  const syncLocalCodexAuth = Effect.fn("InferenceProxy.syncLocalCodexAuth")(
    function* (runtime: NonNullable<typeof running>) {
      if (!(yield* fs.exists(localCodexAuthPath))) return false;
      const localRaw = yield* fs.readFileString(localCodexAuthPath);
      const source = parseLocalCodexAuth(localRaw);
      if (!source) return false;
      const email = jwtClaims(source.tokens.id_token)?.email;
      const identity = codexAccountIdentity(source.tokens.account_id, email);
      if (identity === undefined)
        return yield* failure(
          "Local Codex sign-in has no account email. Add it through T3 settings.",
        );
      const removed = (yield* read).removedLocalAccounts ?? [];
      if (removed.includes(identity) || removed.includes(`codex:${source.tokens.account_id}`))
        return false;
      const authDir = path.join(directory, "accounts");
      const names = yield* fs.readDirectory(authDir);
      let existing:
        | {
            name: string;
            data: Record<string, unknown> & typeof ProxyCodexAuth.Type;
            refreshedAt: number;
          }
        | undefined;
      for (const name of names) {
        if (!name.endsWith(".json") || name !== path.basename(name)) continue;
        const raw = yield* fs
          .readFileString(path.join(authDir, name))
          .pipe(Effect.orElseSucceed(() => ""));
        const decoded = decodeUnknownJson(raw);
        if (Option.isNone(decoded)) continue;
        const data = decoded.value;
        if (!isRecord(data) || !isProxyCodexAuth(data)) continue;
        if (data.account_id !== source.tokens.account_id) continue;
        // Seats of one workspace share an account ID.
        if (codexAccountIdentity(data.account_id, proxyCodexEmail(data)) !== identity) continue;
        const refreshedAt = Date.parse(data.last_refresh);
        if (!Number.isFinite(refreshedAt)) continue;
        if (!existing || refreshedAt > existing.refreshedAt) existing = { name, data, refreshedAt };
      }
      if (existing?.data.disabled === true) return false;
      if (existing && existing.refreshedAt > source.refreshedAt) {
        if (!existing.data.access_token || !existing.data.refresh_token || !existing.data.id_token)
          return false;
        if ((yield* fs.readFileString(localCodexAuthPath)) !== localRaw) return false;
        yield* writeFileStringAtomically({
          filePath: localCodexAuthPath,
          contents: yield* encodeConfig({
            ...source.data,
            last_refresh: existing.data.last_refresh,
            tokens: {
              ...source.tokens,
              access_token: existing.data.access_token,
              refresh_token: existing.data.refresh_token,
              id_token: existing.data.id_token,
            },
          }),
          mode: 0o600,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        return true;
      }
      if (existing && existing.refreshedAt === source.refreshedAt) return false;
      if (
        typeof source.expiresAt !== "number" ||
        source.expiresAt * 1000 <= (yield* Clock.currentTimeMillis)
      )
        return false;
      const accountId = source.tokens.account_id;
      if (accountId.length > 128) return yield* failure("Local Codex account ID is too long.");
      const name =
        existing?.name ??
        `codex-local-${yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(identity))}.json`;
      yield* jsonRequest(
        runtime.baseUrl + "/v0/management/auth-files?name=" + encodeURIComponent(name),
        runtime.management,
        UploadStatus,
        "POST",
        {
          ...existing?.data,
          type: "codex",
          account_id: source.tokens.account_id,
          ...(existing ? {} : { email }),
          access_token: source.tokens.access_token,
          refresh_token: source.tokens.refresh_token,
          id_token: source.tokens.id_token,
          last_refresh: source.lastRefresh,
          expired: DateTime.formatIso(DateTime.makeUnsafe(source.expiresAt * 1000)),
        },
      );
      return true;
    },
    Effect.mapError(safeFailure("Could not sync the local Codex sign-in to CLIProxyAPI.")),
  );

  const syncLocalClaudeAuth = Effect.fn("InferenceProxy.syncLocalClaudeAuth")(
    function* (runtime: NonNullable<typeof running>) {
      if (!(yield* fs.exists(localClaudeAccountPath))) return false;
      const fileCredentials = yield* fs.exists(localClaudeAuthPath);
      let keychainEntry: import("@napi-rs/keyring").AsyncEntry | undefined;
      let nativeRaw: string | undefined;
      if (platform === "darwin" && !env.CLAUDE_CONFIG_DIR?.trim()) {
        if (!username) return false;
        const entry = yield* Effect.try({
          try: () => claudeKeychainEntry(username),
          catch: safeFailure("Could not access Claude credentials in macOS Keychain."),
        });
        const secret = yield* Effect.tryPromise({
          try: async (signal) => {
            try {
              return await entry.getPassword(signal);
            } catch (cause) {
              const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
              if (/no (matching )?entry|not found/i.test(message)) return undefined;
              throw cause;
            }
          },
          catch: safeFailure("Allow T3 Code to access Claude credentials in macOS Keychain."),
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(
            safeFailure("Allow T3 Code to access Claude credentials in macOS Keychain."),
          ),
        );
        if (secret !== undefined) {
          keychainEntry = entry;
          nativeRaw = secret;
        }
      }
      if (nativeRaw === undefined && fileCredentials)
        nativeRaw = yield* fs.readFileString(localClaudeAuthPath);
      if (nativeRaw === undefined) return false;
      const nativeDecoded = decodeUnknownJson(nativeRaw);
      const accountDecoded = decodeUnknownJson(yield* fs.readFileString(localClaudeAccountPath));
      if (Option.isNone(nativeDecoded) || Option.isNone(accountDecoded)) return false;
      const native = nativeDecoded.value;
      const account = accountDecoded.value;
      if (!isRecord(native) || !isLocalClaudeAuth(native) || !isClaudeAccount(account))
        return false;
      const oauth = native.claudeAiOauth;
      const identity = account.oauthAccount;
      if (
        !oauth.accessToken ||
        !oauth.refreshToken ||
        !Number.isFinite(oauth.expiresAt) ||
        !identity.accountUuid ||
        !identity.organizationUuid ||
        !identity.emailAddress.includes("@")
      )
        return false;
      const removed = (yield* read).removedLocalAccounts ?? [];
      if (removed.includes(`claude:${identity.accountUuid}:${identity.organizationUuid}`))
        return false;
      const authDir = path.join(directory, "accounts");
      const names = yield* fs.readDirectory(authDir);
      let existing:
        | {
            name: string;
            data: Record<string, unknown> & typeof ProxyClaudeAuth.Type;
            expiresAt: number;
          }
        | undefined;
      for (const name of names) {
        if (!name.endsWith(".json") || name !== path.basename(name)) continue;
        const raw = yield* fs
          .readFileString(path.join(authDir, name))
          .pipe(Effect.orElseSucceed(() => ""));
        const decoded = decodeUnknownJson(raw);
        if (Option.isNone(decoded)) continue;
        const data = decoded.value;
        if (!isRecord(data) || !isProxyClaudeAuth(data)) continue;
        if (
          data.account_uuid !== identity.accountUuid ||
          data.organization_uuid !== identity.organizationUuid
        )
          continue;
        const expiresAt = Date.parse(data.expired);
        if (!Number.isFinite(expiresAt)) continue;
        if (!existing || expiresAt > existing.expiresAt) existing = { name, data, expiresAt };
      }
      if (existing?.data.disabled === true) return false;
      if (existing && existing.expiresAt > oauth.expiresAt) {
        if (!existing.data.access_token || !existing.data.refresh_token) return false;
        const contents = yield* encodeConfig({
          ...native,
          claudeAiOauth: {
            ...oauth,
            accessToken: existing.data.access_token,
            refreshToken: existing.data.refresh_token,
            expiresAt: existing.expiresAt,
          },
        });
        if (keychainEntry) {
          const current = yield* Effect.tryPromise({
            try: (signal) => keychainEntry!.getPassword(signal),
            catch: safeFailure("Could not read Claude credentials in macOS Keychain."),
          }).pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(safeFailure("Could not read Claude credentials in macOS Keychain.")),
          );
          if (current !== nativeRaw) return false;
          yield* Effect.tryPromise({
            try: (signal) => keychainEntry!.setPassword(contents, signal),
            catch: safeFailure("Could not update Claude credentials in macOS Keychain."),
          }).pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(safeFailure("Could not update Claude credentials in macOS Keychain.")),
          );
        } else {
          if ((yield* fs.readFileString(localClaudeAuthPath)) !== nativeRaw) return false;
          yield* writeFileStringAtomically({
            filePath: localClaudeAuthPath,
            contents,
            mode: 0o600,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        }
        return true;
      }
      if (existing && existing.expiresAt === oauth.expiresAt) return false;
      if (oauth.expiresAt <= (yield* Clock.currentTimeMillis)) return false;
      if (identity.accountUuid.length > 128 || identity.organizationUuid.length > 128)
        return yield* failure("Local Claude account ID is too long.");
      const name =
        existing?.name ??
        `claude-local-${Buffer.from(identity.accountUuid).toString("base64url")}-${Buffer.from(identity.organizationUuid).toString("base64url")}.json`;
      yield* jsonRequest(
        runtime.baseUrl + "/v0/management/auth-files?name=" + encodeURIComponent(name),
        runtime.management,
        UploadStatus,
        "POST",
        {
          ...existing?.data,
          type: "claude",
          account_uuid: identity.accountUuid,
          organization_uuid: identity.organizationUuid,
          organization_name: identity.organizationName ?? "",
          email: identity.emailAddress,
          access_token: oauth.accessToken,
          refresh_token: oauth.refreshToken,
          expired: DateTime.formatIso(DateTime.makeUnsafe(oauth.expiresAt)),
          last_refresh: DateTime.formatIso(yield* DateTime.now),
        },
      );
      return true;
    },
    Effect.mapError(safeFailure("Could not sync the local Claude sign-in to CLIProxyAPI.")),
  );

  const syncLocalAuth = Effect.fn("InferenceProxy.syncLocalAuth")(function* (
    runtime: NonNullable<typeof running>,
  ) {
    const codex = yield* syncLocalCodexAuth(runtime).pipe(Effect.result);
    const claude = yield* syncLocalClaudeAuth(runtime).pipe(Effect.result);
    return {
      changed:
        (Result.isSuccess(codex) && codex.success) || (Result.isSuccess(claude) && claude.success),
      problem:
        [codex, claude]
          .filter(Result.isFailure)
          .map((result) => result.failure.message)
          .join(" ") || null,
    };
  });

  const watchLocalCodexAuth = Effect.gen(function* () {
    if (!(yield* fs.exists(localCodexHome))) {
      yield* fs.watch(path.dirname(localCodexHome)).pipe(
        Stream.filter((event) => path.basename(event.path) === path.basename(localCodexHome)),
        Stream.take(1),
        Stream.runDrain,
      );
    }
    if (!(yield* fs.exists(localCodexHome))) return;
    const changes = fs.watch(localCodexHome).pipe(
      Stream.filter((event) => path.basename(event.path) === "auth.json"),
      Stream.debounce(Duration.millis(100)),
    );
    yield* Stream.runForEach(changes, () =>
      mutex
        .withPermit(
          Effect.gen(function* () {
            const state = yield* read;
            return state.enabled
              ? (yield* syncLocalAuth(yield* ensureWatched(state))).changed
              : false;
          }),
        )
        .pipe(
          Effect.flatMap((changed) => (changed ? refreshLocalProviders() : Effect.void)),
          Effect.ignoreCause({ log: true }),
        ),
    );
  });

  const watchLocalClaudeAuth = Effect.gen(function* () {
    if (!(yield* fs.exists(localClaudeHome))) {
      yield* fs.watch(path.dirname(localClaudeHome)).pipe(
        Stream.filter((event) => path.basename(event.path) === path.basename(localClaudeHome)),
        Stream.take(1),
        Stream.runDrain,
      );
    }
    if (!(yield* fs.exists(localClaudeHome))) return;
    const credentialChanges = fs
      .watch(localClaudeHome)
      .pipe(Stream.filter((event) => path.basename(event.path) === ".credentials.json"));
    const accountChanges = fs
      .watch(path.dirname(localClaudeAccountPath))
      .pipe(
        Stream.filter(
          (event) => path.basename(event.path) === path.basename(localClaudeAccountPath),
        ),
      );
    yield* Stream.runForEach(
      Stream.merge(credentialChanges, accountChanges).pipe(Stream.debounce(Duration.millis(100))),
      () =>
        mutex
          .withPermit(
            Effect.gen(function* () {
              const state = yield* read;
              return state.enabled
                ? (yield* syncLocalAuth(yield* ensureWatched(state))).changed
                : false;
            }),
          )
          .pipe(
            Effect.flatMap((changed) => (changed ? refreshLocalProviders() : Effect.void)),
            Effect.ignoreCause({ log: true }),
          ),
    );
  });

  const watchProxyCodexAuth = Effect.gen(function* () {
    const changes = fs.watch(path.join(directory, "accounts")).pipe(
      Stream.filter((event) => path.basename(event.path).endsWith(".json")),
      Stream.debounce(Duration.millis(100)),
    );
    yield* Stream.runForEach(changes, () =>
      mutex
        .withPermit(
          Effect.gen(function* () {
            const state = yield* read;
            return state.enabled ? (yield* syncLocalAuth(yield* ensure(state))).changed : false;
          }),
        )
        .pipe(
          Effect.flatMap((changed) => (changed ? refreshLocalProviders() : Effect.void)),
          Effect.ignoreCause({ log: true }),
        ),
    );
  });

  // Annotated because the watcher refreshes routes, which start the proxy, which starts this watcher.
  const startProxyAccountWatch: Effect.Effect<void> = Effect.gen(function* () {
    if (proxyAccountWatch) return;
    proxyAccountWatch = yield* watchProxyCodexAuth.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(
        Effect.sync(() => {
          proxyAccountWatch = undefined;
        }),
      ),
      Effect.forkIn(serviceScope),
    );
  });

  // The watcher writes rotated tokens back to the CLI, so it runs whenever the proxy does.
  const ensureWatched = (state: Saved) =>
    ensure(state).pipe(Effect.tap(() => startProxyAccountWatch));

  const stopProxyAccountWatch = Effect.gen(function* () {
    if (!proxyAccountWatch) return;
    yield* Fiber.interrupt(proxyAccountWatch);
    proxyAccountWatch = undefined;
  });

  const watchChild = Effect.fn("InferenceProxy.watchChild")(function* () {
    const child = yield* Queue.take(children);
    yield* child.exitCode;
    if (running?.child !== child) return;
    // Local providers call the sidecar directly, so their next turn cannot wake a stopped host.
    yield* Effect.sleep("1 second");
    yield* mutex
      .withPermit(
        Effect.gen(function* () {
          const state = yield* read;
          if (state.enabled && (!running || running.child === child)) yield* ensureWatched(state);
        }),
      )
      .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }));
  });
  yield* watchChild().pipe(Effect.ignore, Effect.forever, Effect.forkScoped);

  const status = mutex
    .withPermit(
      Effect.gen(function* () {
        const state = yield* read;
        const current = yield* settings.getSettings;
        let routeProblem: string | null = null;
        const summary = {
          routes: Object.entries(current.providerInstances).flatMap(([id, instance]) => {
            const instanceId = ProviderInstanceId.make(id);
            if (
              !isInferenceProviderConfig(instance.config) ||
              !instance.config.inferenceEnabled ||
              !isProviderInstanceEnabledInAnyScope(current, instanceId)
            )
              return [];
            const problem =
              instance.driver === "opencode"
                ? openCodeRouteProblem(
                    instance.environment,
                    providerEnvironment.OPENCODE_CONFIG_CONTENT,
                  )
                : null;
            if (problem) {
              routeProblem = problem;
              return [];
            }
            return [
              {
                instanceId,
                label: `${inferenceHarness(instance.driver)?.label ?? instance.driver}${instance.config.inferenceHostLabel ? ` via ${instance.config.inferenceHostLabel}` : ""}`,
              },
            ];
          }),
          traexAvailable:
            state.enabled && state.sharing && !sharingDenial && (yield* localTraexAvailable),
          routing: state.routing ?? defaultInferenceRouting,
          availableDrivers: [],
          version: state.release?.version ?? proxyVersion,
          enabled: state.enabled,
          sharing: state.sharing,
          consumers: state.grants.map(({ environmentId, label }) => ({ environmentId, label })),
        };
        if (!state.enabled)
          return { status: { ...summary, running: false, accounts: [], problem: routeProblem } };
        return yield* Effect.gen(function* () {
          const runtime = yield* ensureWatched(state);
          const sync = yield* syncLocalAuth(runtime);
          const { files } = yield* jsonRequest(
            runtime.baseUrl + "/v0/management/auth-files",
            runtime.management,
            Files,
          );
          return {
            status: { ...summary, running: true, problem: routeProblem ?? sync.problem },
            runtime,
            files,
          };
        }).pipe(
          Effect.orElseSucceed((e) => ({
            status: {
              ...summary,
              running: false,
              accounts: [],
              problem: safeFailure("CLIProxyAPI failed to start. Check its port or retry hosting.")(
                e,
              ).message,
            },
          })),
        );
      }),
    )
    .pipe(
      Effect.flatMap((snapshot) =>
        Effect.gen(function* () {
          if (!("files" in snapshot)) return snapshot.status;
          const evidence = yield* claudeUsageEvidence(snapshot.runtime, snapshot.files, true);
          const now = yield* Clock.currentTimeMillis;
          return {
            ...snapshot.status,
            availableDrivers: availableDrivers(
              snapshot.files.filter((file) => !evidence.has(file.name)),
            ),
            accounts: snapshot.files
              .filter((file) => !file.runtime_only)
              .map((file) => {
                const availability = accountAvailability(file);
                const retryAfter =
                  availability === "available" ? evidence.get(file.name) : undefined;
                return {
                  name: file.name,
                  provider: file.provider,
                  status: file.status,
                  availability: retryAfter ? ("rateLimited" as const) : availability,
                  ...(retryAfter
                    ? { retryAfter }
                    : availability === "rateLimited" &&
                        file.next_retry_after &&
                        Date.parse(file.next_retry_after) > now
                      ? { retryAfter: file.next_retry_after }
                      : {}),
                };
              }),
          };
        }),
      ),
      Effect.mapError(safeFailure("Could not read inference host settings.")),
    );

  const sharingUrls = Effect.gen(function* () {
    const active = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const port = Option.isSome(active) ? active.value.port : config.port;
    const targets = [
      ...new Set([port, ...(config.devUrl?.port ? [Number(config.devUrl.port)] : [])]),
    ];
    const routes = yield* Effect.forEach(targets, (target) =>
      readTailscaleServeRoutesTo({ host: "127.0.0.1", port: target }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.orElseSucceed(() => []),
      ),
    );
    const route = routes
      .flat()
      .find((r) => r.mount === "/" && r.host?.endsWith(".ts.net") && !r.ambiguous);
    const lans = (yield* direct.resolveAvailable())
      .filter((ep) => ep.kind === "lan")
      .map((ep) => new URL("/api/inference", ep.httpBaseUrl).href)
      .filter((url) => validateRouteUrl(url, false));
    const urls = [
      ...(route ? [new URL(`https://${route.host}:${route.servePort}/api/inference`).href] : []),
      ...lans,
    ];
    return urls;
  });

  const updateRuntime = Effect.fn("InferenceProxy.updateRuntime")(function* (
    operation: "checkUpdate" | "update",
  ) {
    const state = yield* mutex.withPermit(read);
    const denial = managedUpdatesDenial(settings.managedPolicy);
    if (!state.enabled || denial) {
      if (operation === "update")
        return yield* failure(denial ?? "Enable inference hosting first.");
      return {};
    }
    const current = state.release?.version ?? proxyVersion;
    const release = yield* latest.pipe(
      Effect.mapError(safeFailure("Could not check upstream CLIProxyAPI releases.")),
    );
    const available =
      release.version.localeCompare(current, "en", { numeric: true }) > 0 ? release.version : null;
    if (operation === "checkUpdate" || !available) return { update: { current, available } };
    yield* install(directory, release).pipe(
      Effect.provide(installContext),
      Effect.mapError(safeFailure("Could not install the verified CLIProxyAPI update.")),
    );
    yield* mutex.withPermit(
      Effect.gen(function* () {
        const before = yield* read;
        if (!before.enabled) return yield* failure("Hosting was disabled during the update.");
        const next = { ...before, release: { version: release.version } };
        yield* Effect.uninterruptibleMask((restore) =>
          stop.pipe(
            Effect.andThen(restore(ensureWatched(next))),
            Effect.andThen(save(next)),
            Effect.onError(() => stop.pipe(Effect.andThen(ensureWatched(before)), Effect.ignore)),
          ),
        );
      }),
    );
    const runtimeDir = path.join(directory, "runtime");
    yield* fs.readDirectory(runtimeDir).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          (entry) => {
            const match = /^(\d+\.\d+\.\d+)-(.+)$/.exec(entry);
            if (
              !match ||
              match[2] !== release.target ||
              match[1] === current ||
              match[1]!.localeCompare(release.version, "en", { numeric: true }) >= 0
            )
              return Effect.void;
            return fs.remove(path.join(runtimeDir, entry), { recursive: true });
          },
          { discard: true },
        ),
      ),
      Effect.catch(() => Effect.logWarning("Could not remove obsolete CLIProxyAPI releases.")),
    );
    return { update: { current: release.version, available: null } };
  });
  type HostAction = Exclude<InferenceProxyAction, { operation: "checkUpdate" | "update" }>;
  const manageHost = Effect.fn("InferenceProxy.manageHost")(function* (input: HostAction) {
    const state = yield* read;
    if (input.operation === "configure") {
      // Another client may have started sharing while this client was still on the setup screen.
      if (input.expectedEnabled !== undefined && state.enabled !== input.expectedEnabled) return {};
      if (input.enabled && input.sharing && sharingDenial) return yield* failure(sharingDenial);
      if (!input.enabled) {
        yield* save({ ...state, enabled: false, sharing: false, grants: [] }).pipe(
          Effect.andThen(stop),
          Effect.uninterruptible,
        );
        yield* stopProxyAccountWatch;
      } else {
        const next = {
          ...state,
          enabled: true,
          sharing: input.sharing,
          grants: input.sharing ? state.grants : [],
        };
        yield* Effect.uninterruptibleMask((restore) =>
          restore(ensureWatched(next)).pipe(
            Effect.andThen(save(next)),
            Effect.onError(() => (state.enabled ? Effect.void : stop)),
          ),
        );
      }
      return {};
    }
    if (input.operation === "setRouting") {
      const routing = state.routing ?? defaultInferenceRouting;
      const next = {
        ...state,
        routing: {
          strategy: input.strategy ?? routing.strategy,
          sessionAffinity: input.sessionAffinity ?? routing.sessionAffinity,
        },
      };
      const runtime = yield* ensureWatched(state);
      yield* writeConfig(next.routing, runtime).pipe(
        Effect.andThen(
          save(next).pipe(Effect.onError(() => writeConfig(routing, runtime).pipe(Effect.orDie))),
        ),
        Effect.uninterruptible,
      );
      return {};
    }
    if (input.operation === "removeRoute") {
      const revised = yield* settings.reviseProviderInstance(input.instanceId, (current) => {
        if (!current || !isInferenceRoutingEnabled(current.config))
          return failure("This provider is not using inference routing.");
        return Effect.succeed({
          instance: { ...current, config: { ...current.config, inferenceEnabled: false } },
          result: undefined,
        });
      });
      yield* registry.reconcile(
        deriveProviderInstanceConfigMap(revised.settings, providerEnvironment),
      );
      return {};
    }
    if (input.operation === "revoke") {
      yield* save({
        ...state,
        grants: state.grants.filter((g) => g.environmentId !== input.environmentId),
        revokedConsumers: [...new Set([...(state.revokedConsumers ?? []), input.environmentId])],
      });
      return {};
    }
    const runtime = yield* ensureWatched(state);
    const base = runtime.baseUrl + "/v0/management/";
    const admin = runtime.management;
    switch (input.operation) {
      case "signIn": {
        // A sign-in is allowed while any permitted harness can use the account it adds.
        const usable = INFERENCE_DRIVERS.some(
          (driver) =>
            INFERENCE_HARNESSES[driver].upstreams.includes(input.upstream) &&
            isManagedDriverAllowed(settings.managedPolicy, ProviderDriverKind.make(driver)),
        );
        if (!usable) return yield* failure("This provider is disabled by environment policy.");
        const prefix = LOCAL_ACCOUNT_PREFIX[input.upstream];
        if (prefix && state.removedLocalAccounts?.some((account) => account.startsWith(prefix)))
          yield* save({
            ...state,
            removedLocalAccounts: state.removedLocalAccounts.filter(
              (account) => !account.startsWith(prefix),
            ),
          });
        const login = yield* jsonRequest(base + input.upstream + "-auth-url", admin, Login);
        if (URL.parse(login.url)?.protocol !== "https:")
          return yield* failure("Invalid sign-in URL.");
        return { login };
      }
      case "check":
        return yield* jsonRequest(
          base + "get-auth-status?state=" + encodeURIComponent(input.state),
          admin,
          AuthStatus,
        );
      case "cancel":
        yield* jsonRequest(
          base + "oauth-session?state=" + encodeURIComponent(input.state),
          admin,
          Schema.Unknown,
          "DELETE",
        );
        return {};
      case "callback": {
        const url = URL.parse(input.callback);
        if (!url || url.searchParams.get("state") !== input.state)
          return yield* failure("Paste the complete callback URL from this sign-in.");
        yield* jsonRequest(base + "oauth-callback", admin, Schema.Unknown, "POST", {
          redirect_url: input.callback,
        });
        return { status: "wait" as const };
      }
      case "removeAccount": {
        if (input.name !== path.basename(input.name) || !input.name.endsWith(".json"))
          return yield* failure("Invalid account file name.");
        const account = Option.getOrUndefined(
          decodeUnknownJson(
            yield* fs
              .readFileString(path.join(directory, "accounts", input.name))
              .pipe(Effect.orElseSucceed(() => "")),
          ),
        );
        const identity = !isRecord(account)
          ? undefined
          : isProxyCodexAuth(account)
            ? codexAccountIdentity(account.account_id, proxyCodexEmail(account))
            : isProxyClaudeAuth(account)
              ? `claude:${account.account_uuid}:${account.organization_uuid}`
              : undefined;
        if (identity !== undefined && !state.removedLocalAccounts?.includes(identity))
          yield* save({
            ...state,
            removedLocalAccounts: [...(state.removedLocalAccounts ?? []), identity],
          });
        yield* jsonRequest(
          base + "auth-files?name=" + encodeURIComponent(input.name),
          admin,
          Schema.Unknown,
          "DELETE",
        );
        return {};
      }
    }
  }, mutex.withPermit);
  const manage = Effect.fn("InferenceProxy.manage")(
    function* (input: InferenceProxyAction) {
      switch (input.operation) {
        case "checkUpdate":
          return yield* updateRuntime("checkUpdate");
        case "update": {
          const result = yield* updateMutex.withPermit(updateRuntime("update"));
          yield* refreshLocalProviders();
          return result;
        }
        default: {
          const result = yield* manageHost(input);
          if (input.operation === "removeAccount" || ("status" in result && result.status === "ok"))
            yield* refreshLocalProviders();
          return result;
        }
      }
    },
    Effect.mapError(safeFailure("Could not update the inference host.")),
  );

  const grant = Effect.fn("InferenceProxy.grant")(
    function* ({ automatic, capability, ...consumer }: InferenceGrantInput) {
      const state = yield* read;
      const hostId = yield* environment.getEnvironmentId;
      const identity = { hostId, consumerId: consumer.environmentId };
      if (capability === "traex") {
        if (
          !state.enabled ||
          !state.sharing ||
          hostId === consumer.environmentId ||
          !(yield* localBridgeTarget)
        )
          return yield* failure("Traex sharing is unavailable on this host.");
      } else {
        const runtime = yield* ensureWatched(state);
        if (hostId === consumer.environmentId)
          return { ...identity, baseUrl: runtime.baseUrl, key: runtime.key };
      }
      if (sharingDenial) return yield* failure(sharingDenial);
      if (!state.sharing) return yield* failure("Enable sharing on the inference host first.");
      if (automatic && state.revokedConsumers?.includes(consumer.environmentId))
        return yield* failure(
          "Sharing with this environment was revoked. Choose the host again to restore it.",
        );
      const [baseUrl, ...alternates] = (yield* sharingUrls).slice(0, 33);
      const existing = state.grants.find((g) => g.environmentId === consumer.environmentId);
      const key = existing?.key ?? (yield* newKey);
      const traexKey = existing?.traexKey ?? (capability === "traex" ? yield* newKey : undefined);
      if (!existing || existing.label !== consumer.label || existing.traexKey !== traexKey)
        yield* save({
          ...state,
          revokedConsumers: (state.revokedConsumers ?? []).filter(
            (id) => id !== consumer.environmentId,
          ),
          grants: [
            ...state.grants.filter((g) => g.environmentId !== consumer.environmentId),
            { ...consumer, key, ...(traexKey ? { traexKey } : {}) },
          ],
        });
      return {
        ...identity,
        baseUrl: baseUrl ?? `t3-environment:${hostId}`,
        alternates,
        key: capability === "traex" ? traexKey! : key,
      };
    },
    mutex.withPermit,
    Effect.mapError(safeFailure("Could not resolve the host's inference addresses.")),
  );

  const bindRoutes = Effect.fn("InferenceProxy.bindRoutes")(
    function* (port: number) {
      const { providerInstances } = yield* settings.getSettings;
      const state = yield* read;
      const routeKey = yield* Effect.result(traexConsumerRouteKey(store));
      if (Result.isSuccess(routeKey))
        traexRoutes.bind(
          port,
          routeKey.success,
          !!state.traexHosts?.length || !!(yield* localBridgeTarget),
        );
      else yield* Effect.logWarning("Could not load the Traex consumer credential.");
      const routePools = [...(state.routePools ?? [])];
      const bindings: {
        id: string;
        driver: InferenceDriver;
        hostId: EnvironmentId;
        key: string;
        baseUrl: string;
      }[] = [];
      let poolsChanged = false;
      for (const [id, instance] of Object.entries(providerInstances)) {
        if (!isInferenceProviderConfig(instance.config)) continue;
        const driver = INFERENCE_DRIVERS.find(
          (candidate) => ProviderDriverKind.make(candidate) === instance.driver,
        );
        if (!driver || id !== defaultInstanceIdForDriver(ProviderDriverKind.make(driver))) continue;
        const config = instance.config;
        if (typeof config.inferenceKey !== "string") continue;
        bindings.push({
          id,
          driver,
          hostId: config.inferenceHostId,
          key: config.inferenceKey,
          baseUrl: config.inferenceBaseUrl,
        });
        const index = routePools.findIndex((entry) => entry.driver === driver);
        if (
          index < 0 ||
          routePools[index]!.primary.hostId !== config.inferenceHostId ||
          routePools[index]!.primary.key !== config.inferenceKey
        ) {
          const pool = {
            driver,
            primary: {
              hostId: config.inferenceHostId,
              baseUrl: config.inferenceBaseUrl,
              key: config.inferenceKey,
              models: [...config.inferenceModels],
              ...(config.inferenceConnection ? { connection: config.inferenceConnection } : {}),
            },
            alternates: [],
          };
          if (index < 0) routePools.push(pool);
          else routePools[index] = pool;
          poolsChanged = true;
        }
      }
      if (poolsChanged) yield* save({ ...state, routePools });
      for (const binding of bindings) {
        const url = `http://127.0.0.1:${port}/api/inference/linked/${binding.driver}/${encodeURIComponent(binding.hostId)}`;
        if (binding.baseUrl === url) continue;
        const instanceId = ProviderInstanceId.make(binding.id);
        yield* settings.reviseProviderInstance(
          instanceId,
          Effect.fnUntraced(function* (current) {
            if (
              !current ||
              current.driver !== ProviderDriverKind.make(binding.driver) ||
              !isInferenceProviderConfig(current.config) ||
              current.config.inferenceHostId !== binding.hostId ||
              !(yield* matchesRouteKey(instanceId, current.config.inferenceKey, binding.key))
            )
              return yield* failure("The inference route changed.");
            return {
              instance: { ...current, config: { ...current.config, inferenceBaseUrl: url } },
              result: undefined,
            };
          }),
        );
      }
      yield* registry.reconcile(
        deriveProviderInstanceConfigMap(yield* settings.getSettings, providerEnvironment),
      );
    },
    Effect.mapError(safeFailure("Could not refresh inference providers.")),
  );

  const peerAddress = Effect.fn("InferenceProxy.peerAddress")(function* (
    hostId: EnvironmentId,
    connection?: InferenceHostConnection,
  ) {
    const saved = yield* links.get(hostId).pipe(
      Effect.catchIf(
        (error) => error.reason === "disabled",
        () => Effect.succeedNone,
      ),
    );
    const candidates = [
      ...(connection ? [links.resolveAddress(connection, hostId)] : []),
      ...(Option.isSome(saved) ? [links.resolve(hostId).pipe(Effect.map((peer) => peer.url))] : []),
    ];
    if (!candidates.length)
      return yield* failure("Connect to the inference host, then choose its route again.");
    return yield* Effect.firstSuccessOf(candidates).pipe(
      Effect.mapError((error) => failure(error.message)),
    );
  });

  const candidateAddress = Effect.fn("InferenceProxy.candidateAddress")(function* (
    candidate: Omit<SavedRouteCandidate, "models">,
    ownId: EnvironmentId,
  ) {
    if (candidate.hostId === ownId)
      return (yield* mutex.withPermit(read.pipe(Effect.flatMap(ensureWatched)))).baseUrl;
    if (candidate.connection || !validateRouteUrl(candidate.baseUrl, false))
      return new URL("/api/inference", yield* peerAddress(candidate.hostId, candidate.connection))
        .href;
    const peer = yield* jsonRequest(
      new URL("/.well-known/t3/environment", candidate.baseUrl).href,
      undefined,
      Peer,
    );
    if (peer.environmentId !== candidate.hostId)
      return yield* failure("The inference address belongs to another environment.");
    return candidate.baseUrl;
  });

  const hasTraexConsumerKey = Effect.fn("InferenceProxy.hasTraexConsumerKey")((key: string) =>
    store.get(TRAEX_CONSUMER_SECRET).pipe(
      Effect.map(
        (stored) => Option.isSome(stored) && Buffer.from(stored.value).toString("hex") === key,
      ),
      Effect.mapError(safeFailure("Could not check the Traex consumer credential.")),
    ),
  );
  const traexCandidates = Effect.fn("InferenceProxy.traexCandidates")(
    function* (scope: "host" | "resolve", key: string, model?: string, catalog = false) {
      const state = yield* read;
      if (scope === "host") {
        if (
          sharingDenial ||
          !state.enabled ||
          !state.sharing ||
          !state.grants.some((grant) => grant.traexKey === key)
        )
          return null;
        const target = yield* localBridgeTarget;
        return target ? [{ ...target, models: [] as readonly string[] }] : [];
      }
      if (!(yield* hasTraexConsumerKey(key))) return null;
      const direct = yield* localBridgeTarget;
      const directModels = direct ? yield* Cache.get(bridgeModels, direct) : [];
      const local =
        direct && directModels.length && (!model || directModels.includes(model))
          ? [{ ...direct, models: directModels }]
          : [];
      if (!catalog && !model && local.length) return local;
      const ownId = yield* environment.getEnvironmentId;
      const remote = yield* Effect.forEach(
        state.traexHosts ?? [],
        (candidate) =>
          Effect.gen(function* () {
            const url = yield* candidateAddress(candidate, ownId).pipe(Effect.timeout("3 seconds"));
            const target = { baseUrl: new URL(TRAEX_HOST_PATH, url).href, key: candidate.key };
            const models = yield* Cache.get(bridgeModels, target);
            return { ...target, models };
          }).pipe(Effect.option),
        { concurrency: 8 },
      );
      const checked = Arr.getSomes(remote);
      return [
        ...local,
        ...checked.filter(
          (target) => target.models.length && (!model || target.models.includes(model)),
        ),
      ];
    },
    Effect.mapError(safeFailure("Could not resolve the Traex bridge.")),
  );

  const routeProbes = yield* Cache.make({
    capacity: 64,
    timeToLive: "15 seconds",
    lookup: Effect.fn("InferenceProxy.probeRoute")(
      function* (input: { candidate: SavedRouteCandidate; driver: InferenceDriver }) {
        const ownId = yield* environment.getEnvironmentId;
        const baseUrl = yield* candidateAddress(input.candidate, ownId);
        const health =
          input.candidate.hostId === ownId
            ? yield* mutex.withPermit(localHealth(input.candidate.key))
            : yield* jsonRequest(baseUrl + "/health", input.candidate.key, InferenceRouteHealth);
        const models = health.availableDrivers.includes(input.driver)
          ? input.candidate.models.filter((model) => health.models.includes(model))
          : [];
        const unavailableModels = input.candidate.models.filter((model) =>
          health.unavailableModels?.includes(model),
        );
        return { baseUrl, key: input.candidate.key, models, unavailableModels };
      },
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => undefined),
    ),
  });

  const hasRoutePool = Effect.fn("InferenceProxy.hasRoutePool")(
    function* (key: string, hostId: EnvironmentId | undefined, driver: string | undefined) {
      if (!hostId || !driver) return false;
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
      const current = yield* settings.getSettings;
      const instance = current.providerInstances[instanceId];
      if (
        !instance ||
        !isProviderInstanceEnabledInAnyScope(current, instanceId) ||
        !isInferenceProviderConfig(instance.config) ||
        !instance.config.inferenceEnabled ||
        instance.config.inferenceHostId !== hostId ||
        instance.config.inferenceKey !== key
      )
        return false;
      return (
        (yield* read).routePools?.some(
          (entry) =>
            entry.driver === driver && entry.primary.hostId === hostId && entry.primary.key === key,
        ) ?? false
      );
    },
    Effect.mapError(safeFailure("Could not inspect inference routes.")),
  );

  const routeCoolingDown = (driver: string, hostId: EnvironmentId, model: string, now: number) =>
    (routeFailures.get(`${driver}\0${hostId}\0${model}`) ?? 0) > now;

  const routeCandidates = Effect.fn("InferenceProxy.routeCandidates")(
    function* (
      key: string,
      hostId?: EnvironmentId,
      driver?: string,
      model?: string,
      includeAll = false,
      includeUnavailable = false,
    ) {
      if (hostId === undefined) {
        const target = yield* authorize(key);
        return target ? [{ ...target, models: [], unavailableModels: [] }] : null;
      }
      const current = yield* settings.getSettings;
      const active = Arr.findFirst(INFERENCE_DRIVERS, (candidateDriver) => {
        if (driver !== undefined && candidateDriver !== driver) return Option.none();
        const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(candidateDriver));
        const route = current.providerInstances[instanceId]?.config;
        return isInferenceProviderConfig(route) &&
          route.inferenceEnabled &&
          route.inferenceHostId === hostId &&
          route.inferenceKey === key &&
          isProviderInstanceEnabledInAnyScope(current, instanceId)
          ? Option.some({ driver: candidateDriver, route })
          : Option.none();
      });
      if (Option.isNone(active)) return null;
      const { driver: activeDriver, route } = active.value;
      const pool = (yield* read).routePools?.find((entry) => entry.driver === activeDriver);
      if (!pool || pool.primary.hostId !== hostId || pool.primary.key !== key) {
        const target = yield* authorize(key, hostId, driver);
        return target
          ? [{ ...target, models: route.inferenceModels, unavailableModels: [] }]
          : null;
      }
      const matching = model
        ? [pool.primary, ...pool.alternates].filter((candidate) => candidate.models.includes(model))
        : includeAll
          ? [pool.primary, ...pool.alternates]
          : [pool.primary];
      if (matching.length === 0) return [];
      const candidates = yield* Effect.forEach(
        matching,
        (candidate) => Cache.get(routeProbes, { candidate, driver: activeDriver }),
        { concurrency: "unbounded" },
      );
      const now = yield* Clock.currentTimeMillis;
      const available = candidates.flatMap((candidate, index) => {
        if (!candidate) return [];
        const host = matching[index]!;
        const cooling = (slug: string) => routeCoolingDown(activeDriver, host.hostId, slug, now);
        const models = candidate.models.filter((slug) => !cooling(slug));
        const unavailableModels = includeUnavailable
          ? [...new Set([...candidate.unavailableModels, ...host.models.filter(cooling)])]
          : [];
        return (models.length && (model === undefined || models.includes(model))) ||
          unavailableModels.length
          ? [{ ...candidate, hostId: host.hostId, models, unavailableModels }]
          : [];
      });
      return available;
    },
    Effect.mapError(safeFailure("Could not resolve inference hosts.")),
  );

  const recordRouteOutcome = Effect.fn("InferenceProxy.recordRouteOutcome")(function* (input: {
    driver: string;
    hostId: EnvironmentId;
    model: string;
    status: number;
    retryAfter?: string;
    retryAfterMs?: string;
  }) {
    const key = `${input.driver}\0${input.hostId}\0${input.model}`;
    if (input.status >= 200 && input.status < 300) {
      routeFailures.delete(key);
      return;
    }
    if (!isRetryableInferenceStatus(input.status)) return;
    const now = yield* Clock.currentTimeMillis;
    const retryDelay = inferenceRetryDelayMs(input.retryAfter, input.retryAfterMs, now);
    const duration =
      (input.status === 429 || input.status === 503) && retryDelay !== undefined
        ? Math.max(
            input.status === 429 ? 5_000 : 0,
            Math.min(retryDelay, Number.MAX_SAFE_INTEGER - now),
          )
        : input.status === 502 || input.status === 503 || input.status === 529
          ? 5_000
          : 30_000;
    routeFailures.set(key, now + duration);
  });

  const authorize = Effect.fn("InferenceProxy.authorize")(
    function* (key: string, hostId?: EnvironmentId, driver?: string) {
      if (hostId !== undefined) {
        const current = yield* settings.getSettings;
        const allowed = INFERENCE_DRIVERS.map((candidateDriver) => {
          const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(candidateDriver));
          const instance = current.providerInstances[instanceId];
          return (driver === undefined || candidateDriver === driver) &&
            instance !== undefined &&
            isProviderInstanceEnabledInAnyScope(current, instanceId) &&
            isInferenceProviderConfig(instance.config) &&
            instance.config.inferenceEnabled &&
            instance.config.inferenceHostId === hostId &&
            instance.config.inferenceKey === key
            ? instance.config
            : undefined;
        }).find((config) => config !== undefined);
        if (!allowed) return null;
        const pool = (yield* read).routePools?.find(
          (entry) =>
            (driver === undefined || entry.driver === driver) &&
            entry.primary.hostId === hostId &&
            entry.primary.key === key,
        );
        if (pool)
          return {
            baseUrl: yield* candidateAddress(pool.primary, yield* environment.getEnvironmentId),
            key,
          };
        const address = yield* peerAddress(hostId, allowed.inferenceConnection);
        return { baseUrl: new URL("/api/inference", address).href, key };
      }
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const state = yield* read;
          if (
            sharingDenial ||
            !state.enabled ||
            !state.sharing ||
            !state.grants.some((g) => g.key === key)
          )
            return null;
          const runtime = yield* ensureWatched(state);
          // The watchers sync rotated tokens. This sync only covers a watcher that stopped.
          const now = yield* Clock.currentTimeMillis;
          if (now - lastRequestSync >= REQUEST_SYNC_INTERVAL_MS) {
            lastRequestSync = now;
            yield* syncLocalAuth(runtime);
          }
          return { baseUrl: runtime.baseUrl, key: runtime.key };
        }),
      );
    },
    Effect.mapError(safeFailure("Inference host unavailable.")),
  );

  const localHealth = Effect.fn("InferenceProxy.localHealth")(function* (expectedKey?: string) {
    const state = yield* read;
    if (!state.enabled) return yield* failure("Inference hosting is disabled.");
    const runtime = yield* ensureWatched(state);
    if (expectedKey !== undefined && runtime.key !== expectedKey)
      return yield* failure("Inference route credentials have changed. Connect the route again.");
    const [{ files }, { data }] = yield* Effect.all(
      [
        jsonRequest(runtime.baseUrl + "/v0/management/auth-files", runtime.management, Files),
        jsonRequest(runtime.baseUrl + "/v1/models", runtime.key, Models),
      ],
      { concurrency: "unbounded" },
    );
    const evidence = yield* claudeUsageEvidence(runtime, files, false);
    const now = yield* Clock.currentTimeMillis;
    const excludedNames = new Set(evidence.keys());
    const registeredModels = new Map<string, readonly string[]>();
    if (needsAccountModelLookup(files, excludedNames, now)) {
      const eligible = files
        .filter(
          (file) =>
            !file.disabled &&
            ((file.status === "active" && !file.unavailable && !excludedNames.has(file.name)) ||
              file.cooldowns?.some(
                (cooldown) =>
                  cooldown.scope === "credential" && Date.parse(cooldown.retry_at) > now,
              )),
        )
        .slice(0, 128);
      const keys: AccountModelsCacheKey[] = eligible.map((file) => ({
        baseUrl: runtime.baseUrl,
        management: runtime.management,
        id: file.id || file.name,
      }));
      const results = yield* cachedResults(accountModelsCache, keys, "500 millis");
      for (const [index, file] of eligible.entries()) {
        const cached = results[index]!;
        if (Option.isSome(cached) && cached.value)
          registeredModels.set(
            file.id || file.name,
            cached.value.models.map((model) => model.id),
          );
      }
    }
    const models = modelsForDriver(data, "opencode", {
      accounts: files,
      excludedNames,
      registeredModels,
      now,
    });
    const unavailable = new Set<string>();
    for (const file of files) {
      if (file.disabled) continue;
      for (const cooldown of file.cooldowns ?? []) {
        if (!(Date.parse(cooldown.retry_at) > now)) continue;
        if (cooldown.scope === "model" && cooldown.model_key) unavailable.add(cooldown.model_key);
        if (cooldown.scope === "credential")
          for (const model of registeredModels.get(file.id || file.name) ?? [])
            unavailable.add(model);
      }
    }
    for (const model of models) unavailable.delete(model);
    return {
      availableDrivers: availableDrivers(files.filter((file) => !evidence.has(file.name))),
      models,
      ...(unavailable.size ? { unavailableModels: [...unavailable] } : {}),
    };
  });

  const poolHealth = Effect.fn("InferenceProxy.poolHealth")(function* (
    key: string,
    hostId: EnvironmentId,
    driver: InferenceDriver,
  ) {
    const candidates = yield* routeCandidates(key, hostId, driver, undefined, true, true);
    if (candidates === null) return null;
    const models = new Set(candidates.flatMap((candidate) => candidate.models));
    const unavailable = new Set(candidates.flatMap((candidate) => candidate.unavailableModels));
    for (const model of models) unavailable.delete(model);
    return {
      availableDrivers: models.size ? [driver] : [],
      models: [...models],
      ...(unavailable.size ? { unavailableModels: [...unavailable] } : {}),
    };
  });

  const health = Effect.fn("InferenceProxy.health")(
    function* (key: string, hostId?: EnvironmentId, driver?: string) {
      const pool = hostId
        ? (yield* read).routePools?.find(
            (entry) =>
              (driver === undefined || entry.driver === driver) &&
              entry.primary.hostId === hostId &&
              entry.primary.key === key,
          )
        : undefined;
      if (pool) return yield* poolHealth(key, pool.primary.hostId, pool.driver);
      const target = yield* authorize(key, hostId, driver);
      if (!target) return null;
      return hostId === undefined
        ? yield* mutex.withPermit(localHealth())
        : yield* jsonRequest(target.baseUrl + "/health", target.key, InferenceRouteHealth);
    },
    Effect.mapError(safeFailure("Could not check inference host health.")),
  );

  const routeHealth = Effect.fn("InferenceProxy.routeHealth")(
    function* (route: InferenceProviderConfig, key: string, driver?: string) {
      const pool = (yield* read).routePools?.find(
        (entry) =>
          (driver === undefined || entry.driver === driver) &&
          entry.primary.hostId === route.inferenceHostId &&
          entry.primary.key === key,
      );
      if (pool) {
        const health = yield* poolHealth(key, route.inferenceHostId, pool.driver);
        if (health === null) return yield* failure("No authorized inference host is available.");
        return health;
      }
      const ownId = yield* environment.getEnvironmentId;
      if (route.inferenceHostId === ownId) return yield* mutex.withPermit(localHealth(key));
      const address =
        route.inferenceConnection || route.inferenceBaseUrl.includes("/api/inference/linked/")
          ? new URL(
              "/api/inference",
              yield* peerAddress(route.inferenceHostId, route.inferenceConnection),
            ).href
          : route.inferenceBaseUrl;
      return yield* jsonRequest(address + "/health", key, InferenceRouteHealth);
    },
    Effect.mapError(safeFailure("Could not check inference route health.")),
  );

  const connect = Effect.fn("InferenceProxy.connect")(
    function* (
      { grant, driver, hostLabel, connection, preserveProviderEnabled }: InferenceRouteInput,
      fallback = false,
    ) {
      const id = yield* environment.getEnvironmentId;
      if (id !== grant.consumerId)
        return yield* failure("Invalid inference route for this environment.");
      if (driver === "traex" && (!fallback || grant.hostId === id))
        return yield* failure("Invalid Traex peer route.");
      const driverKind = ProviderDriverKind.make(driver === "traex" ? "codex" : driver);
      if (!isManagedDriverAllowed(settings.managedPolicy, driverKind))
        return yield* failure("This driver is disabled by environment policy.");
      const local = id === grant.hostId;
      const candidates = local ? [grant.baseUrl] : [grant.baseUrl, ...(grant.alternates ?? [])];
      const environmentRoute = !local && grant.baseUrl === `t3-environment:${grant.hostId}`;
      if (!environmentRoute && candidates.some((url) => !validateRouteUrl(url, local)))
        return yield* failure("Invalid inference route for this environment.");
      const resolved = local
        ? Result.succeed(undefined)
        : yield* peerAddress(grant.hostId, connection).pipe(Effect.result);
      if ((environmentRoute || connection?.ssh) && Result.isFailure(resolved))
        return yield* resolved.failure;
      const peer = Result.isSuccess(resolved) ? resolved.success : undefined;
      const peerUrl = peer ? new URL("/api/inference", peer).href : undefined;
      const addresses = [
        ...new Set([
          ...(peerUrl ? [peerUrl] : []),
          ...(environmentRoute || connection?.ssh ? [] : candidates),
        ]),
      ];
      if (local) {
        const runtime = yield* mutex.withPermit(read.pipe(Effect.flatMap(ensure)));
        if (runtime.baseUrl !== grant.baseUrl || runtime.key !== grant.key)
          return yield* failure("The local inference grant has changed. Request a new route.");
      }
      const { baseUrl, data } = yield* Effect.firstSuccessOf(
        addresses.map((url) =>
          Effect.gen(function* () {
            if (!local && url !== peerUrl) {
              const peer = yield* jsonRequest(
                new URL("/.well-known/t3/environment", url).href,
                undefined,
                Peer,
              );
              if (peer.environmentId !== grant.hostId)
                return yield* failure("The address belongs to another T3 environment.");
            }
            const path = driver === "traex" ? "/traex/host/v1/models" : "/v1/models";
            const { data } = yield* jsonRequest(url + path, grant.key, Models);
            if (driver === "traex" && !data.length)
              return yield* failure("The host has no available Traex models.");
            return { baseUrl: url, data };
          }),
        ),
      );
      if (driver === "traex") {
        const candidate = {
          hostId: grant.hostId,
          baseUrl,
          key: grant.key,
          ...(baseUrl === peerUrl && connection ? { connection } : {}),
        };
        const changed = yield* mutex.withPermit(
          Effect.gen(function* () {
            const state = yield* read;
            const hosts = state.traexHosts ?? [];
            if (
              Equal.equals(
                hosts.find((host) => host.hostId === candidate.hostId),
                candidate,
              )
            )
              return false;
            yield* save({
              ...state,
              traexHosts: [...hosts.filter((host) => host.hostId !== candidate.hostId), candidate],
            });
            traexRoutes.setDiscovered(true);
            return true;
          }),
        );
        if (changed)
          yield* registry.reconcile(
            deriveProviderInstanceConfigMap(yield* settings.getSettings, providerEnvironment),
          );
        return;
      }
      const health = local
        ? yield* mutex.withPermit(localHealth())
        : yield* jsonRequest(baseUrl + "/health", grant.key, InferenceRouteHealth);
      if (!health.availableDrivers.includes(driver))
        return yield* failure("The inference host has no available accounts for this provider.");
      const models = modelsForDriver(data, driver);
      if (!models.length)
        return yield* failure("Sign in to an account for this provider on the host, then retry.");
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
      const linked = baseUrl === peerUrl;
      const active = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const port = Option.isSome(active) ? active.value.port : config.port;
      const loopbackUrl = (host: EnvironmentId) =>
        `http://127.0.0.1:${port}/api/inference/linked/${driver}/${encodeURIComponent(host)}`;
      const candidate: SavedRouteCandidate = {
        hostId: grant.hostId,
        baseUrl,
        key: grant.key,
        models,
        ...(linked && connection ? { connection } : {}),
      };
      if (fallback) {
        const revised = yield* mutex.withPermit(
          Effect.gen(function* () {
            const currentSettings = yield* settings.getSettings;
            const configured = currentSettings.providerInstances[instanceId];
            if (
              !configured ||
              !isProviderInstanceEnabledInAnyScope(currentSettings, instanceId) ||
              !isInferenceProviderConfig(configured.config) ||
              !configured.config.inferenceEnabled
            )
              return undefined;
            const primaryRoute = configured.config;
            if (primaryRoute.inferenceHostId === grant.hostId) return undefined;
            if (typeof primaryRoute.inferenceKey !== "string")
              return yield* failure("The primary inference credential is unavailable.");
            const primaryKey = primaryRoute.inferenceKey;
            const state = yield* read;
            const existing = state.routePools?.find(
              (entry) =>
                entry.driver === driver &&
                entry.primary.hostId === primaryRoute.inferenceHostId &&
                entry.primary.key === primaryKey,
            );
            const primary: SavedRouteCandidate = existing?.primary ?? {
              hostId: primaryRoute.inferenceHostId,
              baseUrl: primaryRoute.inferenceBaseUrl,
              key: primaryKey,
              models: [...primaryRoute.inferenceModels],
              ...(primaryRoute.inferenceConnection
                ? { connection: primaryRoute.inferenceConnection }
                : {}),
            };
            const alternates = [
              ...(existing?.alternates ?? []).filter((entry) => entry.hostId !== grant.hostId),
              candidate,
            ];
            yield* save({
              ...state,
              routePools: [
                ...(state.routePools ?? []).filter((entry) => entry.driver !== driver),
                { driver, primary, alternates },
              ],
            });
            return yield* settings
              .reviseProviderInstance(
                instanceId,
                Effect.fnUntraced(function* (current, currentSettings) {
                  if (
                    !current ||
                    !isProviderInstanceEnabledInAnyScope(currentSettings, instanceId) ||
                    !isInferenceProviderConfig(current.config) ||
                    !current.config.inferenceEnabled ||
                    current.config.inferenceHostId !== primaryRoute.inferenceHostId ||
                    !(yield* matchesRouteKey(instanceId, current.config.inferenceKey, primaryKey))
                  )
                    return yield* failure("The inference route changed.");
                  return {
                    instance: {
                      ...current,
                      config: {
                        ...current.config,
                        inferenceBaseUrl: loopbackUrl(primary.hostId),
                        inferenceModels: [
                          ...new Set([primary, ...alternates].flatMap((entry) => entry.models)),
                        ],
                      },
                    },
                    result: undefined,
                  };
                }),
              )
              .pipe(Effect.onError(() => save(state).pipe(Effect.orDie)));
          }),
        );
        if (!revised) return;
        yield* registry.reconcile(
          deriveProviderInstanceConfigMap(revised.settings, providerEnvironment),
        );
        return;
      }
      const home = path.join(config.stateDir, "providers", "inference", instanceId);
      yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
      const revised = yield* mutex.withPermit(
        Effect.gen(function* () {
          const state = yield* read;
          const existing = state.routePools?.find((entry) => entry.driver === driver);
          const updated = yield* settings.reviseProviderInstance(
            instanceId,
            Effect.fnUntraced(function* (current) {
              const problem =
                driver === "opencode"
                  ? openCodeRouteProblem(
                      current?.environment,
                      providerEnvironment.OPENCODE_CONFIG_CONTENT,
                    )
                  : null;
              if (problem) return yield* failure(problem);
              const native = current ?? { driver: ProviderDriverKind.make(driver), config: {} };
              const { inferenceConnection: _previousConnection, ...nativeConfig } = providerConfig(
                native.config,
              )
                ? native.config
                : {};
              const preserve =
                existing?.primary.hostId === grant.hostId &&
                existing.primary.key === grant.key &&
                isInferenceProviderConfig(current?.config) &&
                current.config.inferenceHostId === grant.hostId &&
                (yield* matchesRouteKey(instanceId, current.config.inferenceKey, grant.key));
              const alternates = preserve ? existing.alternates : [];
              return {
                instance: {
                  ...native,
                  ...(preserveProviderEnabled && current ? {} : { enabled: true }),
                  config: {
                    ...nativeConfig,
                    inferenceEnabled: true,
                    inferenceHostId: grant.hostId,
                    inferenceHostLabel: local ? "" : hostLabel,
                    inferenceBaseUrl: loopbackUrl(grant.hostId),
                    inferenceKey: grant.key,
                    inferenceModels: [
                      ...new Set([...models, ...alternates.flatMap((entry) => entry.models)]),
                    ],
                    inferenceHomePath: home,
                    ...(linked && connection ? { inferenceConnection: connection } : {}),
                  },
                },
                result: alternates,
              };
            }),
          );
          yield* save({
            ...state,
            routePools: [
              ...(state.routePools ?? []).filter((entry) => entry.driver !== driver),
              {
                driver,
                primary: candidate,
                alternates: updated.result,
              },
            ],
          });
          return updated;
        }),
      );
      yield* registry.reconcile(
        deriveProviderInstanceConfigMap(revised.settings, providerEnvironment),
      );
    },
    Effect.mapError(safeFailure("Could not configure the routed provider.")),
  );
  const registerFallback = Effect.fn("InferenceProxy.registerFallback")(
    (input: InferenceRouteInput) => connect(input, true),
  );
  const refreshRouteCatalogs = Effect.fn("InferenceProxy.refreshRouteCatalogs")(function* (
    localOnly: boolean,
    targetInstanceId?: ProviderInstanceId,
  ) {
    const hostId = yield* environment.getEnvironmentId;
    const { enabled, routePools = [], traexHosts } = yield* read;
    const currentSettings = yield* settings.getSettings;
    const catalogs = yield* Cache.make({
      capacity: 64,
      lookup: Effect.fn("InferenceProxy.fetchRouteCatalog")(
        function* (candidate: Omit<SavedRouteCandidate, "models">) {
          const baseUrl = yield* candidateAddress(candidate, hostId);
          const { data } = yield* jsonRequest(baseUrl + "/v1/models", candidate.key, Models);
          return data;
        },
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => undefined),
      ),
    });
    const refreshCandidate = Effect.fn("InferenceProxy.refreshRouteCandidate")(function* (
      candidate: SavedRouteCandidate,
      driver: InferenceDriver,
    ) {
      if (candidate.hostId === hostId ? !enabled : localOnly) return candidate;
      const { models: _previous, ...connection } = candidate;
      const catalog = yield* Cache.get(catalogs, connection);
      if (catalog === undefined) return candidate;
      const models = modelsForDriver(catalog, driver);
      const discovered = new Set(models);
      const missing = candidate.models.filter((model) => !discovered.has(model));
      const probeKey = { candidate, driver };
      if (!missing.length) {
        yield* Cache.invalidate(routeProbes, probeKey);
      } else {
        // CLIProxyAPI omits a model from /v1/models during a cooldown.
        const now = yield* Clock.currentTimeMillis;
        const health = yield* Cache.refresh(routeProbes, probeKey);
        if (!health) return candidate;
        const retained = missing.filter(
          (model) =>
            routeCoolingDown(driver, candidate.hostId, model, now) ||
            health.unavailableModels.includes(model),
        );
        if (retained.length) {
          const previous = new Set(candidate.models);
          for (const model of retained) discovered.add(model);
          const persisted = [
            ...candidate.models.filter((model) => discovered.has(model)),
            ...models.filter((model) => !previous.has(model)),
          ];
          return Equal.equals(persisted, candidate.models)
            ? candidate
            : { ...candidate, models: persisted };
        }
      }
      return Equal.equals(models, candidate.models) ? candidate : { ...candidate, models };
    });
    let changed =
      (targetInstanceId === undefined || targetInstanceId === TRAEX_BRIDGE_INSTANCE_ID) &&
      traexRoutes.setDiscovered(!!traexHosts?.length || !!(yield* localBridgeTarget));
    for (const pool of routePools) {
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(pool.driver));
      if (targetInstanceId !== undefined && instanceId !== targetInstanceId) continue;
      const active = currentSettings.providerInstances[instanceId];
      if (
        !active ||
        !isProviderInstanceEnabledInAnyScope(currentSettings, instanceId) ||
        !isInferenceProviderConfig(active.config) ||
        !active.config.inferenceEnabled ||
        active.config.inferenceHostId !== pool.primary.hostId ||
        active.config.inferenceKey !== pool.primary.key
      )
        continue;
      const [primary, ...alternates] = yield* Effect.forEach(
        [pool.primary, ...pool.alternates] as const,
        (candidate) => refreshCandidate(candidate, pool.driver),
        { concurrency: 4 },
      );
      const poolChanged = primary !== pool.primary || !Equal.equals(alternates, pool.alternates);
      const inferenceModels = [
        ...new Set([primary, ...alternates].flatMap((candidate) => candidate.models)),
      ];
      if (!poolChanged && Equal.equals(inferenceModels, active.config.inferenceModels)) continue;
      const applied = yield* mutex.withPermit(
        Effect.gen(function* () {
          const before = yield* read;
          if (
            !before.routePools ||
            !Equal.equals(
              before.routePools.find((entry) => entry.driver === pool.driver),
              pool,
            )
          )
            return false;
          if (poolChanged)
            yield* save({
              ...before,
              routePools: before.routePools.map((entry) =>
                entry.driver === pool.driver ? { ...pool, primary, alternates } : entry,
              ),
            });
          const revised = yield* settings
            .reviseProviderInstance(
              instanceId,
              Effect.fnUntraced(function* (current, currentSettings) {
                if (
                  !current ||
                  !isProviderInstanceEnabledInAnyScope(currentSettings, instanceId) ||
                  current.driver !== pool.driver ||
                  !isInferenceProviderConfig(current.config) ||
                  !current.config.inferenceEnabled ||
                  current.config.inferenceHostId !== pool.primary.hostId ||
                  !(yield* matchesRouteKey(
                    instanceId,
                    current.config.inferenceKey,
                    pool.primary.key,
                  ))
                )
                  return yield* failure("The inference route changed during catalog refresh.");
                return {
                  instance: { ...current, config: { ...current.config, inferenceModels } },
                  result: undefined,
                };
              }),
            )
            .pipe(
              Effect.onError(() => (poolChanged ? save(before).pipe(Effect.orDie) : Effect.void)),
              Effect.result,
            );
          return Result.isSuccess(revised);
        }).pipe(Effect.uninterruptible),
      );
      changed ||= applied;
    }
    if (changed)
      yield* registry.reconcile(
        deriveProviderInstanceConfigMap(yield* settings.getSettings, providerEnvironment),
      );
  }, catalogMutex.withPermit);
  const refreshLocalProviders = () => refreshRouteCatalogs(true);
  const [refreshCatalog, invalidateCatalog] = yield* Effect.cachedInvalidateWithTTL(
    refreshRouteCatalogs(false).pipe(Effect.ignoreCause),
    "15 seconds",
  );
  const refreshModelCatalog = (fresh?: boolean, instanceId?: ProviderInstanceId) => {
    if (instanceId !== undefined)
      return refreshRouteCatalogs(false, instanceId).pipe(Effect.ignoreCause);
    return fresh ? invalidateCatalog.pipe(Effect.andThen(refreshCatalog)) : refreshCatalog;
  };
  yield* watchLocalCodexAuth.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  yield* watchLocalClaudeAuth.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  yield* read.pipe(
    Effect.flatMap((state) =>
      state.enabled
        ? ensureWatched(state).pipe(Effect.flatMap((runtime) => syncLocalAuth(runtime)))
        : Effect.void,
    ),
    mutex.withPermit,
    Effect.ignore,
    Effect.forkScoped,
  );
  return {
    status,
    manage,
    authorize,
    hasRoutePool,
    routeCandidates,
    traexCandidates,
    hasTraexConsumerKey,
    recordRouteOutcome,
    health,
    routeHealth,
    grant,
    connect,
    registerFallback,
    bindRoutes,
    refreshModelCatalog,
  };
});

export class InferenceProxy extends Context.Service<
  InferenceProxy,
  {
    readonly status: Effect.Effect<InferenceProxyStatus, InferenceProxyError>;
    readonly health: (
      key: string,
      hostId?: EnvironmentId,
      driver?: string,
    ) => Effect.Effect<InferenceRouteHealth | null, InferenceProxyError>;
    readonly routeHealth: (
      route: InferenceProviderConfig,
      key: string,
      driver?: string,
    ) => Effect.Effect<InferenceRouteHealth, InferenceProxyError>;
    readonly manage: (
      input: InferenceProxyAction,
    ) => Effect.Effect<InferenceProxyActionResult, InferenceProxyError>;
    readonly grant: (
      input: InferenceGrantInput,
    ) => Effect.Effect<InferenceRouteGrant, InferenceProxyError>;
    readonly connect: (input: InferenceRouteInput) => Effect.Effect<void, InferenceProxyError>;
    readonly registerFallback: (
      input: InferenceRouteInput,
    ) => Effect.Effect<void, InferenceProxyError>;
    readonly bindRoutes: (port: number) => Effect.Effect<void, InferenceProxyError>;
    readonly refreshModelCatalog: (
      fresh?: boolean,
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<void>;
    readonly authorize: (
      key: string,
      hostId?: EnvironmentId,
      driver?: string,
    ) => Effect.Effect<{ baseUrl: string; key: string } | null, InferenceProxyError>;
    readonly hasTraexConsumerKey: (key: string) => Effect.Effect<boolean, InferenceProxyError>;
    readonly traexCandidates: (
      scope: "host" | "resolve",
      key: string,
      model?: string,
      catalog?: boolean,
    ) => Effect.Effect<
      ReadonlyArray<{
        baseUrl: string;
        key: string;
        models: ReadonlyArray<string>;
        hostId?: EnvironmentId;
      }> | null,
      InferenceProxyError
    >;
    readonly routeCandidates: (
      key: string,
      hostId?: EnvironmentId,
      driver?: string,
      model?: string,
      includeAll?: boolean,
    ) => Effect.Effect<
      ReadonlyArray<{
        baseUrl: string;
        key: string;
        models: ReadonlyArray<string>;
        hostId?: EnvironmentId;
      }> | null,
      InferenceProxyError
    >;
    readonly hasRoutePool: (
      key: string,
      hostId: EnvironmentId | undefined,
      driver: string | undefined,
    ) => Effect.Effect<boolean, InferenceProxyError>;
    readonly recordRouteOutcome: (input: {
      driver: string;
      hostId: EnvironmentId;
      model: string;
      status: number;
      retryAfter?: string;
      retryAfterMs?: string;
    }) => Effect.Effect<void>;
  }
>()("t3/inference/InferenceProxy") {}
export const layer = Layer.effect(InferenceProxy, make).pipe(
  Layer.provide(TraexProviderRoutes.layer),
);
