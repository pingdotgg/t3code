import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  UsageShareConnection,
  UsageShareGrant,
  UsageShareLimits,
  UsageShareSourceKind,
  UsageShareUsage,
  UsageSharingError,
  type UsageShareCodeResult,
  type UsageSharingOverview,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRuntimeUpdater from "../providerRuntimes/ProviderRuntimeUpdater.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DEFAULT_OLLAMA_BASE_URL } from "../ollama/ollamaRuntime.ts";
import {
  decodeShareCode,
  encodeShareCode,
  grantSecretMatches,
  grantToken,
  hashGrantSecret,
  newGrantId,
  newGrantSecret,
} from "./shareCode.ts";
import { admitRequest, currentUsage, periodStart } from "./shareLimits.ts";

/** Paths under the owner's server where recipients reach the relay. */
export const SHARE_ROUTE_PREFIX = "/api/usage-share/v1";
export const SHARE_RELAY_PREFIX = `${SHARE_ROUTE_PREFIX}/relay`;
const SHARE_PROVIDER_NAME = "continuum_share";
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;

const StoredGrant = Schema.Struct({
  id: Schema.String,
  secretHash: Schema.String,
  label: Schema.String,
  recipientNote: Schema.String,
  sourceKind: UsageShareSourceKind,
  models: Schema.Array(Schema.String),
  limits: UsageShareLimits,
  usage: UsageShareUsage,
  paused: Schema.Boolean,
  revoked: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
});
type StoredGrant = typeof StoredGrant.Type;

const StoredConnection = Schema.Struct({
  ...UsageShareConnection.fields,
  endpoint: Schema.String,
  grantId: Schema.String,
});
type StoredConnection = typeof StoredConnection.Type;

const StoredState = Schema.Struct({
  endpoint: Schema.NullOr(Schema.String),
  sources: Schema.Record(Schema.String, Schema.Struct({ baseUrl: Schema.NullOr(Schema.String) })),
  grants: Schema.Array(StoredGrant),
  connections: Schema.Array(StoredConnection),
});
type StoredState = typeof StoredState.Type;
const EMPTY_STATE: StoredState = { endpoint: null, sources: {}, grants: [], connections: [] };
const StoredStateJson = Schema.fromJsonString(StoredState);
const encodeState = Schema.encodeEffect(StoredStateJson);

/** What the relay answers a recipient about its own share. Nothing about the owner. */
export const ShareInfo = Schema.Struct({
  label: Schema.String,
  sourceKind: UsageShareSourceKind,
  models: Schema.Array(Schema.String),
  limits: UsageShareLimits,
  usage: UsageShareUsage,
  status: Schema.Literals(["active", "paused", "revoked", "expired", "limit-reached"]),
  message: Schema.NullOr(Schema.String),
});
type ShareInfo = typeof ShareInfo.Type;
const ShareInfoJson = Schema.fromJsonString(ShareInfo);
const decodeShareInfo = Schema.decodeEffect(ShareInfoJson);

/** Where each source's requests go, and how the owner's credential is attached. */
export interface RelayUpstream {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Paths a recipient may call, after the relay prefix. */
  readonly allowedPaths: ReadonlySet<string>;
  /** Paths that generate output and count against the budget. */
  readonly generatingPaths: ReadonlySet<string>;
}

const OPENAI_STYLE_PATHS = new Set(["/v1/responses", "/v1/models", "/v1/chat/completions"]);
const OPENAI_GENERATING = new Set(["/v1/responses", "/v1/chat/completions"]);
const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens", "/v1/models"]);
const ANTHROPIC_GENERATING = new Set(["/v1/messages"]);
const DEFAULT_BASE_URLS: Record<UsageShareSourceKind, string> = {
  "anthropic-api": "https://api.anthropic.com",
  "openai-api": "https://api.openai.com",
  "openrouter-api": "https://openrouter.ai/api",
  ollama: DEFAULT_OLLAMA_BASE_URL,
};

export type RelayAdmission =
  | {
      readonly ok: true;
      readonly grantId: string;
      readonly upstream: RelayUpstream;
      readonly counts: boolean;
      /** Releases the slot and records what the upstream reported. */
      readonly finish: (usage: {
        inputTokens: number;
        outputTokens: number;
      }) => Effect.Effect<void>;
    }
  | { readonly ok: false; readonly status: number; readonly message: string };

export class UsageSharingService extends Context.Service<
  UsageSharingService,
  {
    readonly overview: Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly setSource: (input: {
      readonly kind: UsageShareSourceKind;
      readonly apiKey?: string | null | undefined;
      readonly baseUrl?: string | null | undefined;
    }) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly setEndpoint: (
      endpoint: string | null,
    ) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly createGrant: (input: {
      readonly label: string;
      readonly recipientNote: string;
      readonly sourceKind: UsageShareSourceKind;
      readonly models: ReadonlyArray<string>;
      readonly limits: UsageShareLimits;
      readonly expiresAt: string | null;
    }) => Effect.Effect<UsageShareCodeResult, UsageSharingError>;
    readonly updateGrant: (input: {
      readonly id: string;
      readonly label?: string | undefined;
      readonly recipientNote?: string | undefined;
      readonly models?: ReadonlyArray<string> | undefined;
      readonly limits?: UsageShareLimits | undefined;
      readonly expiresAt?: string | null | undefined;
      readonly paused?: boolean | undefined;
      readonly resetUsage?: boolean | undefined;
    }) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly revokeGrant: (id: string) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly rotateGrant: (id: string) => Effect.Effect<UsageShareCodeResult, UsageSharingError>;
    readonly redeem: (code: string) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly refreshConnection: (
      id: string,
    ) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    readonly removeConnection: (
      id: string,
    ) => Effect.Effect<UsageSharingOverview, UsageSharingError>;
    /** Relay side: checks a recipient's token and returns the share's status, for `/info`. */
    readonly info: (
      grantId: string,
      secret: string,
    ) => Effect.Effect<{
      readonly status: number;
      readonly info: ShareInfo | null;
      readonly message: string;
    }>;
    /** Relay side: admits one request to `path` for `model`, or says why not. */
    readonly admit: (input: {
      readonly grantId: string;
      readonly secret: string;
      readonly path: string;
      readonly model: string | null;
      readonly clientAddress: string;
    }) => Effect.Effect<RelayAdmission>;
  }
>()("t3/usageSharing/UsageSharingService") {}

type FetchInfoResult =
  | { readonly ok: true; readonly info: ShareInfo }
  | { readonly ok: false; readonly status: number; readonly message: string };

const sharingError = (message: string) => new UsageSharingError({ message });

/** `http(s)://host[:port]`, null to clear, or undefined when the text is not an address. */
function normalizeEndpoint(endpoint: string | null): string | null | undefined {
  if (endpoint === null || endpoint.trim() === "") return null;
  try {
    const url = new URL(endpoint.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

const keySecretName = (kind: UsageShareSourceKind) => `usage-share-key-${kind}`;

function grantStatus(grant: StoredGrant, now: DateTime.Utc): ShareInfo["status"] {
  if (grant.revoked) return "revoked";
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= DateTime.toEpochMillis(now))
    return "expired";
  if (grant.paused) return "paused";
  const usage = currentUsage(grant.usage, grant.limits.period, now);
  const admit = admitRequest({ limits: grant.limits, usage, inFlight: 0 });
  return admit.ok ? "active" : "limit-reached";
}

const STATUS_MESSAGES: Record<ShareInfo["status"], string | null> = {
  active: null,
  paused: "The owner has paused this shared connection.",
  revoked: "The owner has revoked this shared connection.",
  expired: "This sharing code has expired.",
  "limit-reached": "This shared connection has used its allowance for now.",
};

/** The provider instance a recipient's redeemed code becomes. Holds no owner credential. */
function buildShareInstance(input: {
  readonly connection: Pick<StoredConnection, "label" | "sourceKind" | "endpoint" | "models">;
  readonly token: string;
  readonly binaryPath: string;
  readonly home: string;
}): ProviderInstanceConfig {
  const relay = `${input.connection.endpoint}${SHARE_RELAY_PREFIX}`;
  const customModels = input.connection.models.map((slug) => ({ slug, name: slug }));
  if (input.connection.sourceKind === "anthropic-api") {
    // Claude Code's documented LLM-gateway settings: requests go to the relay with this token.
    return {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: `${input.connection.label} (shared)`,
      enabled: true,
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: relay, sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: input.token, sensitive: true },
        { name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", value: "1", sensitive: false },
      ],
      config: {
        ...(input.binaryPath === "" ? {} : { binaryPath: input.binaryPath }),
        homePath: input.home,
        customModels,
      },
    };
  }
  const name = `${input.connection.label} (shared)`.replace(/"/g, "'");
  return {
    driver: ProviderDriverKind.make("codex"),
    displayName: `${input.connection.label} (shared)`,
    enabled: true,
    environment: [{ name: "CONTINUUM_SHARE_TOKEN", value: input.token, sensitive: true }],
    config: {
      ...(input.binaryPath === "" ? {} : { binaryPath: input.binaryPath }),
      launchArgs: [
        `-c model_provider=${SHARE_PROVIDER_NAME}`,
        `-c 'model_providers.${SHARE_PROVIDER_NAME}.name="${name}"'`,
        `-c 'model_providers.${SHARE_PROVIDER_NAME}.base_url="${relay}/v1"'`,
        `-c 'model_providers.${SHARE_PROVIDER_NAME}.env_key="CONTINUUM_SHARE_TOKEN"'`,
        `-c 'model_providers.${SHARE_PROVIDER_NAME}.wire_api="responses"'`,
      ].join(" "),
      homePath: input.home,
      customModels,
    },
  };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runtimes = yield* ProviderRuntimeUpdater.ProviderRuntimeUpdater;
  const http = yield* HttpClient.HttpClient;
  const statePath = path.join(config.stateDir, "usage-sharing.json");
  const lock = yield* Semaphore.make(1);
  // In memory only: requests running now, and recent request and failed-auth times.
  const inFlight = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const recent = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());

  const readState = fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeEffect(StoredStateJson)),
    Effect.orElseSucceed(() => EMPTY_STATE),
  );
  const writeState = (state: StoredState) =>
    encodeState(state).pipe(
      Effect.flatMap((text) =>
        fs
          .makeDirectory(config.stateDir, { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(`${statePath}.tmp`, text)),
            Effect.andThen(fs.rename(`${statePath}.tmp`, statePath)),
          ),
      ),
      Effect.mapError(() => sharingError("Could not save sharing settings.")),
    );
  const withState = <A>(
    update: (
      state: StoredState,
      now: DateTime.Utc,
    ) => Effect.Effect<readonly [StoredState, A], UsageSharingError>,
  ) =>
    Semaphore.withPermits(
      lock,
      1,
    )(
      Effect.gen(function* () {
        const state = yield* readState;
        const now = yield* DateTime.now;
        const [next, result] = yield* update(state, now);
        if (next !== state) yield* writeState(next);
        return result;
      }),
    );

  const keyFor = (kind: UsageShareSourceKind) =>
    secrets.get(keySecretName(kind)).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const toGrant = (grant: StoredGrant, now: DateTime.Utc, running: number): UsageShareGrant => ({
    id: grant.id,
    label: grant.label,
    recipientNote: grant.recipientNote,
    sourceKind: grant.sourceKind,
    models: grant.models,
    limits: grant.limits,
    usage: currentUsage(grant.usage, grant.limits.period, now),
    status: grantStatus(grant, now),
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    lastUsedAt: grant.lastUsedAt,
    inFlight: running,
  });

  const overviewOf = Effect.fn("UsageSharingService.overviewOf")(function* (
    state: StoredState,
    now: DateTime.Utc,
  ) {
    const running = yield* Ref.get(inFlight);
    const sources = yield* Effect.forEach(UsageShareSourceKind.literals, (kind) =>
      keyFor(kind).pipe(
        Effect.map((key) => ({
          kind,
          configured: kind === "ollama" || Option.isSome(key),
          baseUrl: state.sources[kind]?.baseUrl ?? null,
        })),
      ),
    );
    const connections: ReadonlyArray<UsageShareConnection> = state.connections.map(
      ({ endpoint: _endpoint, grantId: _grantId, ...connection }) => connection,
    );
    return {
      endpoint: state.endpoint,
      sources,
      grants: state.grants
        .filter((grant) => !grant.revoked)
        .map((grant) => toGrant(grant, now, running.get(grant.id) ?? 0)),
      connections,
    } satisfies UsageSharingOverview;
  });

  const overview = withState((state, now) =>
    overviewOf(state, now).pipe(Effect.map((result) => [state, result] as const)),
  );

  const setSource = Effect.fn("UsageSharingService.setSource")(function* (input: {
    readonly kind: UsageShareSourceKind;
    readonly apiKey?: string | null | undefined;
    readonly baseUrl?: string | null | undefined;
  }) {
    if (input.apiKey !== undefined) {
      const key = input.apiKey?.trim() ?? "";
      yield* (
        key === ""
          ? secrets.remove(keySecretName(input.kind))
          : secrets.set(keySecretName(input.kind), new TextEncoder().encode(key))
      ).pipe(Effect.mapError(() => sharingError("Could not store the key securely.")));
    }
    return yield* withState((state, now) =>
      Effect.gen(function* () {
        const next =
          input.baseUrl === undefined
            ? state
            : {
                ...state,
                sources: {
                  ...state.sources,
                  [input.kind]: { baseUrl: input.baseUrl?.trim() || null },
                },
              };
        return [next, yield* overviewOf(next, now)] as const;
      }),
    );
  });

  const setEndpoint = Effect.fn("UsageSharingService.setEndpoint")(function* (
    endpoint: string | null,
  ) {
    const normalized = normalizeEndpoint(endpoint);
    if (normalized === undefined) {
      return yield* sharingError("Enter the address as http://host:port or https://host.");
    }
    return yield* withState((state, now) =>
      Effect.gen(function* () {
        const next = { ...state, endpoint: normalized };
        return [next, yield* overviewOf(next, now)] as const;
      }),
    );
  });

  const issueCode = Effect.fn("UsageSharingService.issueCode")(function* (
    state: StoredState,
    grant: StoredGrant,
    secret: string,
    now: DateTime.Utc,
  ) {
    if (state.endpoint === null) {
      return yield* sharingError("Set the address recipients reach this computer at first.");
    }
    const code = encodeShareCode({ endpoint: state.endpoint, grantId: grant.id, secret });
    return { grant: toGrant(grant, now, 0), code };
  });

  const createGrant = Effect.fn("UsageSharingService.createGrant")(function* (input: {
    readonly label: string;
    readonly recipientNote: string;
    readonly sourceKind: UsageShareSourceKind;
    readonly models: ReadonlyArray<string>;
    readonly limits: UsageShareLimits;
    readonly expiresAt: string | null;
  }) {
    if (input.sourceKind !== "ollama" && Option.isNone(yield* keyFor(input.sourceKind))) {
      return yield* sharingError("Add your API key for this source before sharing it.");
    }
    if (input.models.length === 0)
      return yield* sharingError("Choose at least one model to share.");
    return yield* withState((state, now) =>
      Effect.gen(function* () {
        const secret = newGrantSecret();
        const grant: StoredGrant = {
          id: newGrantId(),
          secretHash: hashGrantSecret(secret),
          label: input.label.trim() || "Shared AI",
          recipientNote: input.recipientNote.trim(),
          sourceKind: input.sourceKind,
          models: [...new Set(input.models.map((model) => model.trim()).filter(Boolean))],
          limits: input.limits,
          usage: {
            periodStart: periodStart(input.limits.period, now),
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
          paused: false,
          revoked: false,
          createdAt: DateTime.formatIso(now),
          expiresAt: input.expiresAt,
          lastUsedAt: null,
        };
        const result = yield* issueCode(state, grant, secret, now);
        return [{ ...state, grants: [...state.grants, grant] }, result] as const;
      }),
    );
  });

  const mapGrant = (id: string, update: (grant: StoredGrant, now: DateTime.Utc) => StoredGrant) =>
    withState((state, now) =>
      Effect.gen(function* () {
        const grant = state.grants.find((candidate) => candidate.id === id && !candidate.revoked);
        if (!grant) return yield* sharingError("That sharing code no longer exists.");
        const next = {
          ...state,
          grants: state.grants.map((candidate) =>
            candidate.id === id ? update(candidate, now) : candidate,
          ),
        };
        return [next, yield* overviewOf(next, now)] as const;
      }),
    );

  const updateGrant = Effect.fn("UsageSharingService.updateGrant")(function* (input: {
    readonly id: string;
    readonly label?: string | undefined;
    readonly recipientNote?: string | undefined;
    readonly models?: ReadonlyArray<string> | undefined;
    readonly limits?: UsageShareLimits | undefined;
    readonly expiresAt?: string | null | undefined;
    readonly paused?: boolean | undefined;
    readonly resetUsage?: boolean | undefined;
  }) {
    return yield* mapGrant(input.id, (grant, now) => {
      const limits = input.limits ?? grant.limits;
      return {
        ...grant,
        ...(input.label === undefined ? {} : { label: input.label.trim() || grant.label }),
        ...(input.recipientNote === undefined ? {} : { recipientNote: input.recipientNote.trim() }),
        ...(input.models === undefined ? {} : { models: input.models }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.paused === undefined ? {} : { paused: input.paused }),
        limits,
        usage: input.resetUsage
          ? {
              periodStart: periodStart(limits.period, now),
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
            }
          : currentUsage(grant.usage, limits.period, now),
      };
    });
  });

  // Revoking keeps a tombstone so the old token keeps failing as "revoked", not "unknown".
  const revokeGrant = (id: string) =>
    mapGrant(id, (grant) => ({ ...grant, revoked: true, secretHash: "" }));

  const rotateGrant = Effect.fn("UsageSharingService.rotateGrant")(function* (id: string) {
    return yield* withState((state, now) =>
      Effect.gen(function* () {
        const grant = state.grants.find((candidate) => candidate.id === id && !candidate.revoked);
        if (!grant) return yield* sharingError("That sharing code no longer exists.");
        const secret = newGrantSecret();
        const rotated = { ...grant, secretHash: hashGrantSecret(secret) };
        const result = yield* issueCode(state, rotated, secret, now);
        return [
          {
            ...state,
            grants: state.grants.map((candidate) => (candidate.id === id ? rotated : candidate)),
          },
          result,
        ] as const;
      }),
    );
  });

  const findGrant = (state: StoredState, grantId: string, secret: string) => {
    const grant = state.grants.find((candidate) => candidate.id === grantId);
    if (!grant) return null;
    if (grant.revoked) return grant;
    return grantSecretMatches(secret, grant.secretHash) ? grant : null;
  };

  /** Sliding-window limiter on request and failed-auth times, keyed by grant or address. */
  const throttled = (key: string, nowMs: number) =>
    Ref.modify(recent, (current) => {
      const times = (current.get(key) ?? []).filter((time) => nowMs - time < RATE_WINDOW_MS);
      const blocked = times.length >= MAX_REQUESTS_PER_WINDOW;
      const next = new Map(current);
      next.set(key, blocked ? times : [...times, nowMs]);
      return [blocked, next] as const;
    });

  const info = Effect.fn("UsageSharingService.info")(function* (grantId: string, secret: string) {
    const state = yield* readState;
    const now = yield* DateTime.now;
    const grant = findGrant(state, grantId, secret);
    if (!grant) return { status: 401, info: null, message: "This sharing code is not valid." };
    const status = grantStatus(grant, now);
    if (status === "revoked") return { status: 403, info: null, message: STATUS_MESSAGES.revoked! };
    return {
      status: 200,
      message: STATUS_MESSAGES[status] ?? "Ready.",
      info: {
        label: grant.label,
        sourceKind: grant.sourceKind,
        models: grant.models,
        limits: grant.limits,
        usage: currentUsage(grant.usage, grant.limits.period, now),
        status,
        message: STATUS_MESSAGES[status],
      },
    };
  });

  const release = (grantId: string) =>
    Ref.update(inFlight, (current) => {
      const next = new Map(current);
      next.set(grantId, Math.max(0, (current.get(grantId) ?? 1) - 1));
      return next;
    });

  const upstreamFor = Effect.fn("UsageSharingService.upstreamFor")(function* (
    state: StoredState,
    kind: UsageShareSourceKind,
  ) {
    const baseUrl = (state.sources[kind]?.baseUrl ?? DEFAULT_BASE_URLS[kind]).replace(/\/+$/, "");
    if (kind === "ollama") {
      const upstream: RelayUpstream = {
        baseUrl,
        headers: {},
        allowedPaths: OPENAI_STYLE_PATHS,
        generatingPaths: OPENAI_GENERATING,
      };
      return upstream;
    }
    const key = yield* keyFor(kind);
    if (Option.isNone(key)) return null;
    const upstream: RelayUpstream =
      kind === "anthropic-api"
        ? {
            baseUrl,
            headers: { "x-api-key": key.value },
            allowedPaths: ANTHROPIC_PATHS,
            generatingPaths: ANTHROPIC_GENERATING,
          }
        : {
            baseUrl,
            headers: { authorization: `Bearer ${key.value}` },
            allowedPaths: OPENAI_STYLE_PATHS,
            generatingPaths: OPENAI_GENERATING,
          };
    return upstream;
  });

  const admit = Effect.fn("UsageSharingService.admit")(function* (input: {
    readonly grantId: string;
    readonly secret: string;
    readonly path: string;
    readonly model: string | null;
    readonly clientAddress: string;
  }) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const deny = (status: number, message: string): RelayAdmission => ({
      ok: false,
      status,
      message,
    });
    if (
      yield* throttled(`auth:${input.clientAddress}`, nowMs).pipe(Effect.map((blocked) => blocked))
    ) {
      return deny(429, "Too many requests. Slow down and try again.");
    }
    return yield* Semaphore.withPermits(
      lock,
      1,
    )(
      Effect.gen(function* () {
        const state = yield* readState;
        const now = DateTime.makeUnsafe(nowMs);
        const grant = findGrant(state, input.grantId, input.secret);
        if (!grant) return deny(401, "This sharing code is not valid.");
        const status = grantStatus(grant, now);
        if (status === "revoked" || status === "expired" || status === "paused") {
          return deny(403, STATUS_MESSAGES[status]!);
        }
        const upstream = yield* upstreamFor(state, grant.sourceKind);
        if (upstream === null)
          return deny(503, "The owner's shared source is not set up right now.");
        if (!upstream.allowedPaths.has(input.path))
          return deny(404, "Not available through sharing.");
        const counts = upstream.generatingPaths.has(input.path);
        if (
          counts &&
          input.model !== null &&
          grant.models.length > 0 &&
          !grant.models.includes(input.model)
        ) {
          return deny(403, `The model ${input.model} is not shared with you.`);
        }
        if (yield* throttled(`grant:${grant.id}`, nowMs)) {
          return deny(429, "Too many requests on this shared connection. Try again in a minute.");
        }
        const running = (yield* Ref.get(inFlight)).get(grant.id) ?? 0;
        const usage = currentUsage(grant.usage, grant.limits.period, now);
        if (counts) {
          const decision = admitRequest({ limits: grant.limits, usage, inFlight: running });
          if (!decision.ok) return deny(429, decision.message);
          yield* Ref.update(inFlight, (current) => new Map(current).set(grant.id, running + 1));
        }
        const finish = Effect.fn("UsageSharingService.finish")(function* (measured: {
          readonly inputTokens: number;
          readonly outputTokens: number;
        }) {
          if (!counts) return;
          yield* release(grant.id);
          yield* withState((current, at) => {
            const latest = current.grants.find((candidate) => candidate.id === grant.id);
            if (!latest) return Effect.succeed([current, undefined] as const);
            const base = currentUsage(latest.usage, latest.limits.period, at);
            const updated: StoredGrant = {
              ...latest,
              lastUsedAt: DateTime.formatIso(at),
              usage: {
                ...base,
                requests: base.requests + 1,
                inputTokens: base.inputTokens + Math.round(measured.inputTokens),
                outputTokens: base.outputTokens + Math.round(measured.outputTokens),
              },
            };
            return Effect.succeed([
              {
                ...current,
                grants: current.grants.map((candidate) =>
                  candidate.id === grant.id ? updated : candidate,
                ),
              },
              undefined,
            ] as const);
          }).pipe(Effect.ignore);
        });
        return { ok: true, grantId: grant.id, upstream, counts, finish } satisfies RelayAdmission;
      }),
    );
  });

  // Recipient side.

  const fetchInfo = Effect.fn("UsageSharingService.fetchInfo")(function* (
    endpoint: string,
    token: string,
  ) {
    const unreachable: FetchInfoResult = {
      ok: false,
      status: 0,
      message: "Could not reach the owner's computer. Check that it is on and reachable from here.",
    };
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${endpoint}${SHARE_ROUTE_PREFIX}/info`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
        ),
      )
      .pipe(Effect.timeout(Duration.seconds(12)), Effect.option);
    if (Option.isNone(response)) return unreachable;
    const body = yield* response.value.text.pipe(Effect.orElseSucceed(() => ""));
    if (response.value.status === 200) {
      const info = yield* decodeShareInfo(body).pipe(Effect.option);
      if (Option.isSome(info)) return { ok: true, info: info.value } satisfies FetchInfoResult;
      return {
        ok: false,
        status: 502,
        message: "The owner's computer sent an unexpected answer.",
      } satisfies FetchInfoResult;
    }
    return {
      ok: false,
      status: response.value.status,
      message:
        /"message"\s*:\s*"([^"]+)"/.exec(body)?.[1] ??
        `The owner's computer answered ${response.value.status}.`,
    } satisfies FetchInfoResult;
  });

  const connectionStatus = (
    result: FetchInfoResult,
  ): Pick<StoredConnection, "status" | "statusMessage"> => {
    if (!result.ok) {
      return {
        status: result.status === 0 || result.status >= 500 ? "unreachable" : "revoked",
        statusMessage: result.message,
      };
    }
    const status = result.info.status;
    return {
      status: status === "active" ? "ready" : status,
      statusMessage: result.info.message,
    };
  };

  const redeem = Effect.fn("UsageSharingService.redeem")(function* (code: string) {
    const payload = decodeShareCode(code);
    if (payload === null)
      return yield* sharingError("That does not look like a Continuum sharing code.");
    const token = grantToken(payload);
    const result = yield* fetchInfo(payload.endpoint, token);
    if (!result.ok) return yield* sharingError(result.message);
    const host = new URL(payload.endpoint).host;
    const id = `${payload.grantId}`;
    const instanceId = ProviderInstanceId.make(
      `shared-${payload.grantId.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`,
    );
    const driver = result.info.sourceKind === "anthropic-api" ? "claudeAgent" : "codex";
    const runtime = yield* runtimes
      .ensureRuntime(driver)
      .pipe(Effect.mapError((error) => sharingError(error.message)));
    const home = path.join(config.stateDir, "usage-share", id);
    yield* fs
      .makeDirectory(home, { recursive: true })
      .pipe(
        Effect.mapError(() => sharingError("Could not create a folder for the shared connection.")),
      );
    const connection: StoredConnection = {
      id,
      label: result.info.label,
      sourceKind: result.info.sourceKind,
      endpointHost: host,
      models: result.info.models,
      providerInstanceId: instanceId,
      ...connectionStatus(result),
      limits: result.info.limits,
      usage: result.info.usage,
      redeemedAt: DateTime.formatIso(yield* DateTime.now),
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      endpoint: payload.endpoint,
      grantId: payload.grantId,
    };
    yield* secrets
      .set(tokenSecretName(id), new TextEncoder().encode(token))
      .pipe(Effect.mapError(() => sharingError("Could not store the shared connection securely.")));
    yield* settings
      .updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: buildShareInstance({
          connection,
          token,
          binaryPath: runtime.executablePath,
          home,
        }),
      })
      .pipe(Effect.mapError(() => sharingError("Could not add the shared connection.")));
    return yield* withState((state, now) =>
      Effect.gen(function* () {
        const next = {
          ...state,
          connections: [...state.connections.filter((existing) => existing.id !== id), connection],
        };
        return [next, yield* overviewOf(next, now)] as const;
      }),
    );
  });

  const tokenSecretName = (connectionId: string) => `usage-share-token-${connectionId}`;
  const tokenFor = (connection: StoredConnection) =>
    secrets.get(tokenSecretName(connection.id)).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );

  const refreshConnection = Effect.fn("UsageSharingService.refreshConnection")(function* (
    id: string,
  ) {
    const state = yield* readState;
    const connection = state.connections.find((candidate) => candidate.id === id);
    if (!connection) return yield* sharingError("That shared connection no longer exists.");
    const token = yield* tokenFor(connection);
    const result =
      token === null
        ? {
            ok: false as const,
            status: 401,
            message: "The shared connection's token is missing. Redeem the code again.",
          }
        : yield* fetchInfo(connection.endpoint, token);
    return yield* withState((current, now) =>
      Effect.gen(function* () {
        const next = {
          ...current,
          connections: current.connections.map((candidate) =>
            candidate.id !== id
              ? candidate
              : {
                  ...candidate,
                  ...connectionStatus(result),
                  ...(result.ok
                    ? {
                        limits: result.info.limits,
                        usage: result.info.usage,
                        models: result.info.models,
                      }
                    : {}),
                  checkedAt: DateTime.formatIso(now),
                },
          ),
        };
        return [next, yield* overviewOf(next, now)] as const;
      }),
    );
  });

  const removeConnection = Effect.fn("UsageSharingService.removeConnection")(function* (
    id: string,
  ) {
    const state = yield* readState;
    const connection = state.connections.find((candidate) => candidate.id === id);
    if (connection) {
      yield* settings
        .updateProviderInstance({
          operation: "remove",
          instanceId: ProviderInstanceId.make(connection.providerInstanceId),
        })
        .pipe(Effect.ignore);
    }
    return yield* withState((current, now) =>
      Effect.gen(function* () {
        const next = {
          ...current,
          connections: current.connections.filter((candidate) => candidate.id !== id),
        };
        return [next, yield* overviewOf(next, now)] as const;
      }),
    );
  });

  return UsageSharingService.of({
    overview,
    setSource,
    setEndpoint,
    createGrant,
    updateGrant,
    revokeGrant,
    rotateGrant,
    redeem,
    refreshConnection,
    removeConnection,
    info,
    admit,
  });
});

export const layer = Layer.effect(UsageSharingService, make);
