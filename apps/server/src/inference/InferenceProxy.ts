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
  type InferenceProviderConfig,
  InferenceHostConnection,
  isInferenceProviderConfig,
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
import { readTailscaleServeRoutesTo } from "@t3tools/tailscale";
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
import * as ManagedProviders from "../policy/managedProviders.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { claudeKeychainEntry } from "./claudeKeychain.ts";
import { install, proxyVersion, resolveRelease, Release } from "./install.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { modelsForDriver, openCodeRouteProblem, validateRouteUrl } from "./routes.ts";

const SavedRouteCandidate = Schema.Struct({
  hostId: EnvironmentId,
  baseUrl: Schema.String,
  key: Schema.String,
  models: Schema.Array(Schema.String),
  connection: Schema.optionalKey(InferenceHostConnection),
});
type SavedRouteCandidate = typeof SavedRouteCandidate.Type;
const Saved = Schema.Struct({
  enabled: Schema.Boolean,
  sharing: Schema.Boolean,
  port: Schema.Int,
  routing: Schema.optionalKey(InferenceRouting),
  release: Schema.optionalKey(Release),
  revokedConsumers: Schema.optionalKey(Schema.Array(EnvironmentId)),
  grants: Schema.Array(Schema.Struct({ ...InferenceConsumer.fields, key: Schema.String })),
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
      name: Schema.String,
      provider: Schema.String,
      status: Schema.String,
      disabled: Schema.optionalKey(Schema.Boolean),
      unavailable: Schema.optionalKey(Schema.Boolean),
      status_message: Schema.optionalKey(Schema.NullOr(Schema.String)),
      next_retry_after: Schema.optionalKey(Schema.NullOr(Schema.String)),
      runtime_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const Peer = Schema.Struct({ environmentId: EnvironmentId });
const Models = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, owned_by: Schema.optional(Schema.String) }),
  ),
});
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

function accountAvailability(account: (typeof Files.Type)["files"][number], now: number) {
  if (account.disabled) return "disabled" as const;
  if (account.status === "active" && !account.unavailable) return "available" as const;
  const reason = account.status_message ?? "";
  if (
    /\b(?:401|403)\b|auth(?:entication)?[_ -]?fail|invalid[_ -]?grant|invalid[_ -]?credential/i.test(
      reason,
    )
  )
    return "authenticationError" as const;
  if (
    /\b429\b|rate[_ -]?limit|quota|cooldown|exhausted/i.test(reason) ||
    (account.next_retry_after && Date.parse(account.next_retry_after) > now)
  )
    return "rateLimited" as const;
  return "unavailable" as const;
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
  const net = yield* NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const links = yield* PeerLinks.PeerLinks;
  const direct = yield* DirectEndpoints;
  const env = yield* HostProcess.Environment;
  const providerEnvironment = ManagedProviders.providerHostEnvironment(settings.managedPolicy, env);
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const username = yield* HostProcess.Username;
  const sharingDenial = managedCapabilityDenial(settings.managedPolicy, "remoteClients");
  const installContext = yield* Effect.context<Effect.Services<ReturnType<typeof install>>>();
  const latest = yield* Effect.cachedWithTTL(
    resolveRelease(undefined).pipe(Effect.provide(installContext)),
    (exit) => (Exit.isSuccess(exit) ? "15 minutes" : 0),
  );
  const mutex = yield* Semaphore.make(1);
  const updateMutex = yield* Semaphore.make(1);
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
        scope: Scope.Closeable;
        baseUrl: string;
        key: string;
        management: string;
      }
    | undefined;
  const read = Effect.gen(function* () {
    if (cached) return cached;
    const raw = yield* store.get("inference-proxy-state");
    cached = Option.isSome(raw) ? yield* decodeSaved(new TextDecoder().decode(raw.value)) : empty;
    return cached;
  });
  const save = Effect.fn("InferenceProxy.save")(function* (next: Saved) {
    yield* store.set("inference-proxy-state", new TextEncoder().encode(yield* encodeSaved(next)));
    cached = next;
  }, Effect.uninterruptible);
  const stop = Effect.gen(function* () {
    if (running) yield* Scope.close(running.scope, Exit.void);
    running = undefined;
  });
  yield* Effect.addFinalizer(() => stop);
  const writeConfig = Effect.fn("InferenceProxy.writeConfig")(function* (
    state: Saved,
    key: string,
    management: string,
  ) {
    const authDir = path.join(directory, "accounts");
    yield* fs.makeDirectory(authDir, { recursive: true, mode: 0o700 });
    const routing = state.routing ?? defaultInferenceRouting;
    const temp = yield* fs.makeTempFileScoped({ directory });
    yield* fs.writeFileString(
      temp,
      yield* encodeConfig({
        "config-version": 8,
        server: { host: "127.0.0.1", port: state.port, "max-request-body-bytes": 64 * 1024 * 1024 },
        oauth: { "auth-dir": authDir },
        access: { "api-keys": [key] },
        requests: { "passthrough-headers": true },
        management: {
          "allow-remote": false,
          "secret-key": management,
          "disable-control-panel": true,
        },
        routing: { strategy: routing.strategy, "session-affinity": routing.sessionAffinity },
      }),
      { mode: 0o600 },
    );
    yield* fs.rename(temp, path.join(directory, "config.yaml"));
  }, Effect.scoped);
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
    const file = path.join(directory, "config.yaml");
    yield* writeConfig(state, key, management);
    const scope = yield* Scope.make();
    const baseUrl = `http://127.0.0.1:${state.port}`;
    return yield* Effect.gen(function* () {
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
      // A fresh management secret proves that this listener belongs to the process we just started.
      yield* jsonRequest(baseUrl + "/v0/management/auth-files", management, Files).pipe(
        Effect.retry({ times: 40, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("8 seconds"),
      );
      running = { child, scope, key, management, baseUrl };
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
        const { providerInstances } = yield* settings.getSettings;
        let routeProblem: string | null = null;
        const summary = {
          routes: Object.entries(providerInstances).flatMap(([id, instance]) => {
            if (
              !isInferenceProviderConfig(instance.config) ||
              !instance.config.inferenceEnabled ||
              instance.enabled === false
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
                instanceId: ProviderInstanceId.make(id),
                label: `${inferenceHarness(instance.driver)?.label ?? instance.driver}${instance.config.inferenceHostLabel ? ` via ${instance.config.inferenceHostLabel}` : ""}`,
              },
            ];
          }),
          routing: state.routing ?? defaultInferenceRouting,
          availableDrivers: [],
          version: state.release?.version ?? proxyVersion,
          enabled: state.enabled,
          sharing: state.sharing,
          consumers: state.grants.map(({ environmentId, label }) => ({ environmentId, label })),
        };
        if (!state.enabled)
          return { ...summary, running: false, accounts: [], problem: routeProblem };
        return yield* Effect.gen(function* () {
          const runtime = yield* ensureWatched(state);
          const sync = yield* syncLocalAuth(runtime);
          const { files } = yield* jsonRequest(
            runtime.baseUrl + "/v0/management/auth-files",
            runtime.management,
            Files,
          );
          const now = yield* Clock.currentTimeMillis;
          return {
            ...summary,
            running: true,
            availableDrivers: availableDrivers(files),
            accounts: files
              .filter((file) => !file.runtime_only)
              .map((file) => {
                const availability = accountAvailability(file, now);
                return {
                  name: file.name,
                  provider: file.provider,
                  status: file.status,
                  availability,
                  ...(availability === "rateLimited" &&
                  file.next_retry_after &&
                  Date.parse(file.next_retry_after) > now
                    ? { retryAfter: file.next_retry_after }
                    : {}),
                };
              }),
            problem: routeProblem ?? sync.problem,
          };
        }).pipe(
          Effect.orElseSucceed((e) => ({
            ...summary,
            running: false,
            accounts: [],
            problem: safeFailure("CLIProxyAPI failed to start. Check its port or retry hosting.")(e)
              .message,
          })),
        );
      }),
    )
    .pipe(Effect.mapError(safeFailure("Could not read inference host settings.")));

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
          port: state.port || (yield* net.reserveLoopbackPort("127.0.0.1")),
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
      const next: Saved = {
        ...state,
        routing: {
          strategy: input.strategy ?? routing.strategy,
          sessionAffinity: input.sessionAffinity ?? routing.sessionAffinity,
        },
      };
      const runtime = yield* ensureWatched(state);
      yield* writeConfig(next, runtime.key, runtime.management).pipe(
        Effect.andThen(
          save(next).pipe(
            Effect.onError(() =>
              writeConfig(state, runtime.key, runtime.management).pipe(Effect.orDie),
            ),
          ),
        ),
        Effect.uninterruptible,
      );
      return {};
    }
    if (input.operation === "removeRoute") {
      const revised = yield* settings.reviseProviderInstance(input.instanceId, (current) => {
        if (
          !current ||
          !isInferenceProviderConfig(current.config) ||
          !current.config.inferenceEnabled
        )
          return failure("This provider is not using inference routing.");
        return Effect.succeed({
          instance: { ...current, config: { ...current.config, inferenceEnabled: false } },
          result: undefined,
        });
      });
      yield* registry.reconcile(
        deriveProviderInstanceConfigMap(revised.settings, providerEnvironment),
      );
      yield* save({
        ...state,
        routePools: (state.routePools ?? []).filter(
          (entry) =>
            defaultInstanceIdForDriver(ProviderDriverKind.make(entry.driver)) !== input.instanceId,
        ),
      });
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
        case "update":
          return yield* updateMutex.withPermit(updateRuntime("update"));
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
    function* ({ automatic, ...consumer }: InferenceGrantInput) {
      const state = yield* read;
      const runtime = yield* ensureWatched(state);
      const hostId = yield* environment.getEnvironmentId;
      const identity = { hostId, consumerId: consumer.environmentId };
      if (hostId === consumer.environmentId)
        return { ...identity, baseUrl: runtime.baseUrl, key: runtime.key };
      if (sharingDenial) return yield* failure(sharingDenial);
      if (!state.sharing) return yield* failure("Enable sharing on the inference host first.");
      if (automatic && state.revokedConsumers?.includes(consumer.environmentId))
        return yield* failure(
          "Sharing with this environment was revoked. Choose the host again to restore it.",
        );
      const [baseUrl, ...alternates] = (yield* sharingUrls).slice(0, 33);
      const existing = state.grants.find((g) => g.environmentId === consumer.environmentId);
      const key = existing?.key ?? (yield* newKey);
      if (!existing || existing.label !== consumer.label)
        yield* save({
          ...state,
          revokedConsumers: (state.revokedConsumers ?? []).filter(
            (id) => id !== consumer.environmentId,
          ),
          grants: [
            ...state.grants.filter((g) => g.environmentId !== consumer.environmentId),
            { ...consumer, key },
          ],
        });
      return { ...identity, baseUrl: baseUrl ?? `t3-environment:${hostId}`, alternates, key };
    },
    mutex.withPermit,
    Effect.mapError(safeFailure("Could not resolve the host's inference addresses.")),
  );

  const bindRoutes = Effect.fn("InferenceProxy.bindRoutes")(
    function* (port: number) {
      const { providerInstances } = yield* settings.getSettings;
      const state = yield* read;
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
        yield* settings.reviseProviderInstance(ProviderInstanceId.make(binding.id), (current) => {
          if (
            !current ||
            current.driver !== ProviderDriverKind.make(binding.driver) ||
            !isInferenceProviderConfig(current.config) ||
            current.config.inferenceHostId !== binding.hostId ||
            current.config.inferenceKey !== binding.key
          )
            return failure("The inference route changed.");
          return Effect.succeed({
            instance: { ...current, config: { ...current.config, inferenceBaseUrl: url } },
            result: undefined,
          });
        });
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
    candidate: SavedRouteCandidate,
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

  const routeProbes = yield* Cache.make({
    capacity: 64,
    timeToLive: "15 seconds",
    lookup: Effect.fn("InferenceProxy.probeRoute")(
      function* (input: { candidate: SavedRouteCandidate; driver: InferenceDriver }) {
        const ownId = yield* environment.getEnvironmentId;
        const baseUrl = yield* candidateAddress(input.candidate, ownId);
        const health =
          input.candidate.hostId === ownId
            ? yield* mutex.withPermit(localHealth())
            : yield* jsonRequest(baseUrl + "/health", input.candidate.key, InferenceRouteHealth);
        const models = input.candidate.models.filter((model) => health.models.includes(model));
        return health.availableDrivers.includes(input.driver) && models.length
          ? { baseUrl, key: input.candidate.key, models }
          : undefined;
      },
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => undefined),
    ),
  });

  const hasFallback = Effect.fn("InferenceProxy.hasFallback")(
    function* (key: string, hostId: EnvironmentId | undefined, driver: string | undefined) {
      if (!hostId || !driver) return false;
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
      const instance = (yield* settings.getSettings).providerInstances[instanceId];
      if (
        !instance ||
        !isInferenceProviderConfig(instance.config) ||
        !instance.config.inferenceEnabled ||
        instance.config.inferenceHostId !== hostId ||
        instance.config.inferenceKey !== key
      )
        return false;
      return (
        (yield* read).routePools?.some(
          (entry) =>
            entry.driver === driver &&
            entry.primary.hostId === hostId &&
            entry.primary.key === key &&
            entry.alternates.length > 0,
        ) ?? false
      );
    },
    Effect.mapError(safeFailure("Could not inspect inference routes.")),
  );

  const routeCandidates = Effect.fn("InferenceProxy.routeCandidates")(
    function* (
      key: string,
      hostId?: EnvironmentId,
      driver?: string,
      model?: string,
      includeAll = false,
    ) {
      if (hostId === undefined) {
        const target = yield* authorize(key);
        return target ? [{ ...target, models: [] }] : null;
      }
      const { providerInstances } = yield* settings.getSettings;
      const active = INFERENCE_DRIVERS.map((candidateDriver) => ({
        driver: candidateDriver,
        instance:
          providerInstances[defaultInstanceIdForDriver(ProviderDriverKind.make(candidateDriver))],
      })).find(
        ({ driver: candidateDriver, instance }) =>
          (driver === undefined || candidateDriver === driver) &&
          instance?.enabled !== false &&
          isInferenceProviderConfig(instance?.config) &&
          instance.config.inferenceEnabled &&
          instance.config.inferenceHostId === hostId &&
          instance.config.inferenceKey === key,
      );
      if (!active || !isInferenceProviderConfig(active.instance?.config)) return null;
      const route = active.instance.config;
      const pool = (yield* read).routePools?.find((entry) => entry.driver === active.driver);
      if (!pool || pool.primary.hostId !== hostId || pool.primary.key !== key) {
        const target = yield* authorize(key, hostId, driver);
        return target ? [{ ...target, models: route.inferenceModels }] : null;
      }
      const matching = model
        ? [pool.primary, ...pool.alternates].filter((candidate) => candidate.models.includes(model))
        : includeAll
          ? [pool.primary, ...pool.alternates]
          : [pool.primary];
      const candidates = yield* Effect.forEach(
        matching.length ? matching : [pool.primary],
        (candidate) => Cache.get(routeProbes, { candidate, driver: active.driver }),
        { concurrency: "unbounded" },
      );
      const now = yield* Clock.currentTimeMillis;
      const available = candidates.flatMap((candidate, index) => {
        if (!candidate) return [];
        const host = (matching.length ? matching : [pool.primary])[index]!;
        const models = candidate.models.filter(
          (slug) => (routeFailures.get(`${active.driver}\0${host.hostId}\0${slug}`) ?? 0) <= now,
        );
        return models.length && (model === undefined || models.includes(model))
          ? [{ ...candidate, hostId: host.hostId, models }]
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
    if (![401, 403, 429, 502, 503].includes(input.status)) return;
    const now = yield* Clock.currentTimeMillis;
    const numericDelay = (value: string | undefined, scale: number) => {
      if (!value?.trim()) return undefined;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) return undefined;
      const delay = amount * scale;
      return Number.isSafeInteger(Math.ceil(delay)) ? Math.ceil(delay) : undefined;
    };
    const millis = numericDelay(input.retryAfterMs, 1);
    const seconds = input.retryAfter?.trim() ? Number(input.retryAfter) : Number.NaN;
    const standard = Number.isFinite(seconds)
      ? numericDelay(input.retryAfter, 1000)
      : input.retryAfter
        ? Date.parse(input.retryAfter) - now
        : undefined;
    const retryDelay =
      millis ??
      (standard !== undefined && Number.isFinite(standard) && standard >= 0 ? standard : undefined);
    const duration =
      input.status === 429 && retryDelay !== undefined
        ? Math.max(5_000, Math.min(retryDelay, Number.MAX_SAFE_INTEGER - now))
        : input.status === 502 || input.status === 503
          ? 5_000
          : 30_000;
    routeFailures.set(key, now + duration);
  });

  const authorize = Effect.fn("InferenceProxy.authorize")(
    function* (key: string, hostId?: EnvironmentId, driver?: string) {
      if (hostId !== undefined) {
        const { providerInstances } = yield* settings.getSettings;
        const allowed = INFERENCE_DRIVERS.map((candidateDriver) => {
          const instance =
            providerInstances[defaultInstanceIdForDriver(ProviderDriverKind.make(candidateDriver))];
          return (driver === undefined || candidateDriver === driver) &&
            instance?.enabled &&
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

  const localHealth = Effect.fn("InferenceProxy.localHealth")(function* () {
    const state = yield* read;
    if (!state.enabled) return yield* failure("Inference hosting is disabled.");
    const runtime = yield* ensureWatched(state);
    const [{ files }, { data }] = yield* Effect.all(
      [
        jsonRequest(runtime.baseUrl + "/v0/management/auth-files", runtime.management, Files),
        jsonRequest(runtime.baseUrl + "/v1/models", runtime.key, Models),
      ],
      { concurrency: "unbounded" },
    );
    return {
      availableDrivers: availableDrivers(files),
      models: data.map((model) => model.id),
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
      if (pool) {
        const candidates = yield* routeCandidates(key, hostId, pool.driver, undefined, true);
        if (candidates === null) return null;
        return {
          availableDrivers: candidates.length ? [pool.driver] : [],
          models: [...new Set(candidates.flatMap((candidate) => candidate.models))],
        };
      }
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
      if (pool?.alternates.length) {
        const candidates = yield* routeCandidates(
          key,
          route.inferenceHostId,
          pool.driver,
          undefined,
          true,
        );
        if (!candidates?.length)
          return yield* failure("No authorized inference host is available.");
        return {
          availableDrivers: [pool.driver],
          models: [...new Set(candidates.flatMap((candidate) => candidate.models))],
        };
      }
      const ownId = yield* environment.getEnvironmentId;
      if (route.inferenceHostId === ownId) {
        return yield* mutex.withPermit(
          Effect.gen(function* () {
            const state = yield* read;
            if (!state.enabled) return yield* failure("Inference hosting is disabled.");
            const runtime = yield* ensureWatched(state);
            if (runtime.key !== key)
              return yield* failure(
                "Inference route credentials have changed. Connect the route again.",
              );
            return yield* localHealth();
          }),
        );
      }
      const address = pool
        ? yield* candidateAddress(pool.primary, ownId)
        : route.inferenceConnection || route.inferenceBaseUrl.includes("/api/inference/linked/")
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
    function* ({ grant, driver, hostLabel, connection }: InferenceRouteInput, fallback = false) {
      const id = yield* environment.getEnvironmentId;
      if (id !== grant.consumerId)
        return yield* failure("Invalid inference route for this environment.");
      if (!isManagedDriverAllowed(settings.managedPolicy, ProviderDriverKind.make(driver)))
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
            const { data } = yield* jsonRequest(url + "/v1/models", grant.key, Models);
            return { baseUrl: url, data };
          }),
        ),
      );
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
            const configured = (yield* settings.getSettings).providerInstances[instanceId];
            if (
              !configured ||
              configured.enabled === false ||
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
            const existing = state.routePools?.find((entry) => entry.driver === driver);
            const primary: SavedRouteCandidate =
              existing?.primary.hostId === primaryRoute.inferenceHostId &&
              existing.primary.key === primaryKey
                ? existing.primary
                : {
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
              .reviseProviderInstance(instanceId, (current) => {
                if (
                  !current ||
                  current.enabled === false ||
                  !isInferenceProviderConfig(current.config) ||
                  !current.config.inferenceEnabled ||
                  current.config.inferenceHostId !== primaryRoute.inferenceHostId ||
                  current.config.inferenceKey !== primaryKey
                )
                  return failure("The inference route changed.");
                return Effect.succeed({
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
                });
              })
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
          const updated = yield* settings.reviseProviderInstance(instanceId, (current) => {
            const problem =
              driver === "opencode"
                ? openCodeRouteProblem(
                    current?.environment,
                    providerEnvironment.OPENCODE_CONFIG_CONTENT,
                  )
                : null;
            if (problem) return failure(problem);
            const native = current ?? { driver: ProviderDriverKind.make(driver), config: {} };
            const { inferenceConnection: _previousConnection, ...nativeConfig } = providerConfig(
              native.config,
            )
              ? native.config
              : {};
            const preserve =
              existing?.primary.hostId === grant.hostId &&
              current?.enabled !== false &&
              isInferenceProviderConfig(current?.config) &&
              current.config.inferenceEnabled &&
              current.config.inferenceHostId === grant.hostId &&
              current.config.inferenceKey === existing.primary.key;
            const alternates = preserve ? existing.alternates : [];
            return Effect.succeed({
              instance: {
                ...native,
                enabled: true,
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
              result: preserve,
            });
          });
          yield* save({
            ...state,
            routePools: [
              ...(state.routePools ?? []).filter((entry) => entry.driver !== driver),
              {
                driver,
                primary: candidate,
                alternates: updated.result ? (existing?.alternates ?? []) : [],
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
  const refreshLocalProviders = Effect.fn("InferenceProxy.refreshLocalProviders")(function* () {
    const state = yield* read;
    if (!state.enabled) return;
    const hostId = yield* environment.getEnvironmentId;
    const local = yield* grant({ environmentId: hostId, label: "Local" });
    const { data } = yield* jsonRequest(local.baseUrl + "/v1/models", local.key, Models);
    const { providerInstances } = yield* settings.getSettings;
    for (const driver of INFERENCE_DRIVERS) {
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
      const existing = providerInstances[instanceId];
      if (
        !existing ||
        !isInferenceProviderConfig(existing.config) ||
        !existing.config.inferenceEnabled ||
        existing.config.inferenceHostId !== hostId
      )
        continue;
      const localModels = modelsForDriver(data, driver);
      const pool = (yield* read).routePools?.find(
        (entry) => entry.driver === driver && entry.primary.hostId === hostId,
      );
      const models = pool
        ? [...new Set([...localModels, ...pool.alternates.flatMap((entry) => entry.models)])]
        : localModels;
      if (pool && pool.primary.models.join("\0") !== localModels.join("\0"))
        yield* mutex.withPermit(
          read.pipe(
            Effect.flatMap((state) =>
              save({
                ...state,
                routePools: (state.routePools ?? []).map((entry) =>
                  entry.driver === driver
                    ? { ...entry, primary: { ...entry.primary, models: localModels } }
                    : entry,
                ),
              }),
            ),
          ),
        );
      const revised = yield* settings.reviseProviderInstance(instanceId, (current) => {
        if (!current) return failure("The local inference provider was removed.");
        return Effect.succeed({
          instance:
            current.driver === driver &&
            isInferenceProviderConfig(current.config) &&
            current.config.inferenceEnabled &&
            current.config.inferenceHostId === hostId
              ? { ...current, config: { ...current.config, inferenceModels: models } }
              : current,
          result: undefined,
        });
      });
      yield* registry.reconcile(
        deriveProviderInstanceConfigMap(revised.settings, providerEnvironment),
      );
    }
  });
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
    hasFallback,
    routeCandidates,
    recordRouteOutcome,
    health,
    routeHealth,
    grant,
    connect,
    registerFallback,
    bindRoutes,
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
    readonly authorize: (
      key: string,
      hostId?: EnvironmentId,
      driver?: string,
    ) => Effect.Effect<{ baseUrl: string; key: string } | null, InferenceProxyError>;
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
    readonly hasFallback: (
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
export const layer = Layer.effect(InferenceProxy, make);
