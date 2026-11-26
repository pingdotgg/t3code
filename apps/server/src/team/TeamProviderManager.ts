import {
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  isTeamProviderInstanceIdForTeam,
  makeTeamProviderInstanceId,
  parseTeamProviderInstanceId,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderThreadId,
  type RunId,
  type TeamAssetsDeltaResponse,
  type TeamPreprompt,
  type TeamProvider,
  type TeamProviderLeaseResponse,
  type TeamSkill,
  type TeamSyncLocalBindingInput,
  type TeamSyncLocalBindingResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { isAntigravitySignInRequiredError } from "../provider/antigravityAuthSupport.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import {
  materializeEphemeralLeaseToken,
  materializeTeamProfileAssets,
  purgeEphemeralLeaseTokens,
  purgeTeamProfileDirectory,
  renderTeamPrepromptsMarkdown,
  resolveTeamProfilePaths,
  selectTeamPrepromptsForDriver,
} from "./TeamProfileMaterializer.ts";
import { readTeamProviderSecret } from "./TeamProviderLeaseService.ts";
import * as TeamRepository from "./TeamRepository.ts";

/** Proactive pre-turn renewal threshold: refresh before starting a turn if < 15 minutes remain. */
const TEAM_PRE_TURN_LEASE_RENEWAL_THRESHOLD_MS = 15 * 60 * 1000;
/** Background renewal lead time: proactively refresh at `expiry - 10 minutes`. */
const TEAM_BACKGROUND_LEASE_RENEWAL_LEAD_MS = 10 * 60 * 1000;
/** Drivers whose running process caches OAuth tokens in RAM and needs a session recycle on rotation. */
const RAM_TOKEN_CACHING_DRIVERS: ReadonlySet<string> = new Set(["antigravity", "claudeAgent"]);
/** Drivers that load `"thread"` pre-prompts natively from `<teamProfile>/{GEMINI,AGENTS,CLAUDE}.md`. */
const NATIVE_PROFILE_INSTRUCTION_DRIVERS: ReadonlySet<string> = new Set([
  "antigravity",
  "codex",
  "claudeAgent",
]);

const decodeLeaseResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    providerInstanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    accessToken: Schema.String,
    tokenType: Schema.String,
    expiresAt: Schema.String,
    expiresInSeconds: Schema.Number,
    email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    authMethod: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const decodeAssetsDeltaResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    teamId: TeamId,
    revision: NonNegativeInt,
    fullSync: Schema.Boolean,
    skills: Schema.Array(Schema.Unknown),
    preprompts: Schema.Array(Schema.Unknown),
    deletedSkillIds: Schema.Array(Schema.String),
    deletedPrepromptIds: Schema.Array(Schema.String),
  }),
);

export class TeamProviderAccessRevokedError extends Schema.TaggedError<TeamProviderAccessRevokedError>()(
  "TeamProviderAccessRevokedError",
  {
    teamId: TeamId,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TeamProviderIsolationError extends Schema.TaggedError<TeamProviderIsolationError>()(
  "TeamProviderIsolationError",
  {
    teamId: TeamId,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TeamProviderRemoteOnlyError extends Schema.TaggedError<TeamProviderRemoteOnlyError>()(
  "TeamProviderRemoteOnlyError",
  {
    teamId: TeamId,
    instanceId: ProviderInstanceId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TeamProviderLeaseFetchError extends Schema.TaggedError<TeamProviderLeaseFetchError>()(
  "TeamProviderLeaseFetchError",
  {
    teamId: TeamId,
    instanceId: ProviderInstanceId,
    status: Schema.optional(Schema.Number),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type TeamProviderTurnGuardError =
  | TeamProviderAccessRevokedError
  | TeamProviderIsolationError
  | TeamProviderRemoteOnlyError
  | TeamProviderLeaseFetchError;

const isTeamProviderAccessRevokedError = Schema.is(TeamProviderAccessRevokedError);

interface CachedLease {
  readonly lease: TeamProviderLeaseResponse;
  readonly expiresAtMs: number;
  readonly lastRefreshedAtMs: number;
}

export interface TeamTurnPreparationResult {
  readonly teamId: TeamId | null;
  readonly recycleWarmSession: boolean;
  /** `"turn"`-scoped pre-prompts (re-injected on every turn). */
  readonly turnPrepromptText: string;
  /** `"thread"`-scoped pre-prompts for generic/ACP agents on Turn 1 only. */
  readonly genericThreadPrepromptText: string;
}

export interface TeamActiveTurnAuthRecoveryResult {
  readonly handled: boolean;
  readonly revoked: boolean;
  readonly message?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function localBindingTokenSecretKey(teamId: TeamId): string {
  const safeTeam = teamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `team-local-binding-token-${safeTeam}`;
}

function isAuthExpiryFailure(error: unknown): boolean {
  if (isAntigravitySignInRequiredError(error)) return true;
  const text = extractErrorText(error);
  return /\b401\b|\bUNAUTHENTICATED\b|sign[- ]?in required|token (?:has )?expired|invalid_token|expired_token|authentication required/i.test(
    text,
  );
}

function extractErrorText(error: unknown): string {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  const stack: Array<unknown> = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null || seen.has(current)) continue;
    if (typeof current === "string") {
      parts.push(current);
      continue;
    }
    if (typeof current !== "object") continue;
    seen.add(current);
    if ("message" in current && typeof current.message === "string") parts.push(current.message);
    if ("detail" in current && typeof current.detail === "string") parts.push(current.detail);
    if ("errorMessage" in current && typeof current.errorMessage === "string") {
      parts.push(current.errorMessage);
    }
    if ("cause" in current && current.cause !== undefined) stack.push(current.cause);
  }
  return parts.join(" ");
}

function buildStrippedAmbientEnv(
  driver: ProviderDriverKind,
): Array<{ readonly name: string; readonly value: string; readonly sensitive: boolean }> {
  const base: Array<{
    readonly name: string;
    readonly value: string;
    readonly sensitive: boolean;
  }> = [
    { name: "OPENAI_API_KEY", value: "", sensitive: false },
    { name: "OPENAI_BASE_URL", value: "", sensitive: false },
    { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
    { name: "ANTHROPIC_BASE_URL", value: "", sensitive: false },
    { name: "GEMINI_API_KEY", value: "", sensitive: false },
    { name: "GOOGLE_API_KEY", value: "", sensitive: false },
    { name: "GOOGLE_GEMINI_BASE_URL", value: "", sensitive: false },
  ];
  if (driver === "claudeAgent") {
    base.push({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: false });
  }
  return base;
}

export class TeamProviderManager extends Context.Service<
  TeamProviderManager,
  {
    /** Returns all virtual `team:<teamId>:<providerInstanceId>` configs for ProviderInstanceRegistry. */
    readonly getVirtualProviderConfigs: Effect.Effect<ProviderInstanceConfigMap>;
    /** Emits whenever virtual team provider instances change and should be reconciled. */
    readonly streamVirtualProviderChanges: Stream.Stream<void>;
    /** Emits instance IDs whose materialized skill/pre-prompt catalog refreshed and should re-probe. */
    readonly streamSkillCatalogRefreshes: Stream.Stream<ReadonlyArray<ProviderInstanceId>>;
    /** Re-materializes Team Server virtual providers/assets and notifies registry subscribers. */
    readonly notifyTeamServerAssetsOrProvidersChanged: () => Effect.Effect<void>;
    /** Registers or updates a Team Server binding on a member's local t3server. */
    readonly syncLocalTeamBinding: (
      input: TeamSyncLocalBindingInput,
    ) => Effect.Effect<TeamSyncLocalBindingResult>;
    /** Removes a Team Server binding from a member's local t3server and purges isolated profiles & tokens. */
    readonly removeLocalTeamBinding: (teamId: TeamId) => Effect.Effect<boolean>;
    /** Fetches `GET /api/team/assets?since=<rev>` delta for a local binding and re-materializes profiles. */
    readonly syncLocalAssetsDelta: (
      teamId: TeamId,
      options?: { readonly targetRevision?: number; readonly forceFull?: boolean },
    ) => Effect.Effect<number, TeamProviderAccessRevokedError>;
    /** Returns the team ID assigned to a project (on Team Server OR via local binding), if any. */
    readonly resolveTeamIdForProject: (input: {
      readonly projectId: ProjectId;
      readonly repoIdentityKey?: string | null;
    }) => Effect.Effect<Option.Option<TeamId>>;
    /** Enforces the strict `team:<T>:*` isolation invariant for any team-assigned project. */
    readonly assertProviderAllowedForProject: (input: {
      readonly projectId: ProjectId;
      readonly repoIdentityKey?: string | null;
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<void, TeamProviderIsolationError | TeamProviderRemoteOnlyError>;
    /** Pre-turn hook: enforces isolation, syncs asset delta, refreshes near-expiry leases (< 15m), resolves pre-prompts. */
    readonly prepareForTurn: (input: {
      readonly projectId: ProjectId;
      readonly repoIdentityKey?: string | null;
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly nativeThreadHasTurns: boolean;
    }) => Effect.Effect<TeamTurnPreparationResult, TeamProviderTurnGuardError>;
    /** In-memory leased OAuth access token lookup used by CodexManagedTokenBroker (zero token on disk). */
    readonly getLeasedAccessToken: (
      virtualInstanceId: ProviderInstanceId,
      options?: { readonly forceRefresh?: boolean },
    ) => Effect.Effect<
      TeamProviderLeaseResponse,
      TeamProviderAccessRevokedError | TeamProviderLeaseFetchError
    >;
    /** Purges transient on-disk ephemeral token files on idle/disconnect/team leave. */
    readonly purgeEphemeralTokensForInstance: (
      virtualInstanceId: ProviderInstanceId,
    ) => Effect.Effect<void>;
    /**
     * Handles an auth/expiry error during an active turn on a `token-lease` virtual instance:
     * - Refreshes the lease (`forceRefresh: true`)
     * - On `403` revocation: purges local token and refuses auto-resume
     * - On success: recycles warm session and triggers `ProviderContinuationRequests` auto-resume.
     */
    readonly handleActiveTurnAuthFailure: (input: {
      readonly virtualInstanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly runId: RunId;
      readonly error: unknown;
      readonly recycleSession: () => Effect.Effect<void>;
      readonly requestContinuation?: (
        request: ProviderContinuationRequests.ProviderContinuationRequest,
      ) => Effect.Effect<void>;
    }) => Effect.Effect<TeamActiveTurnAuthRecoveryResult>;
  }
>()("t3/team/TeamProviderManager") {}

const make = Effect.gen(function* () {
  const assetsRepo = yield* TeamAssetsRepository.TeamAssetsRepository;
  const teamRepo = yield* TeamRepository.TeamRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const continuationRequestsOption = yield* Effect.serviceOption(
    ProviderContinuationRequests.ProviderContinuationRequests,
  );
  const serviceScope = yield* Scope.Scope;

  const virtualChangesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<void>(),
    PubSub.shutdown,
  );
  const skillRefreshPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<ProviderInstanceId>>(),
    PubSub.shutdown,
  );

  const leasesRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, CachedLease>>(new Map());
  const renewalFibersRef = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, Fiber.Fiber<void, never>>
  >(new Map());
  const autoResumedRunsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const cancelRenewalFiber = Effect.fn("TeamProviderManager.cancelRenewalFiber")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const existing = yield* Ref.modify(renewalFibersRef, (current) => {
      const fiber = current.get(instanceId);
      if (!fiber) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(instanceId);
      return [fiber, next] as const;
    });
    if (existing) {
      yield* Fiber.interrupt(existing).pipe(Effect.ignore);
    }
  });

  const readLocalBindingToken = (_teamId: TeamId, secretKey: string | null) =>
    secretKey === null
      ? Effect.succeed(null)
      : secrets.get(secretKey).pipe(
          Effect.map((opt) => (Option.isSome(opt) ? textDecoder.decode(opt.value) : null)),
          Effect.orElseSucceed(() => null),
        );

  const purgeRevokedLocalTeam = Effect.fn("TeamProviderManager.purgeRevokedLocalTeam")(function* (
    teamId: TeamId,
  ) {
    const bindingOpt = yield* assetsRepo
      .getLocalBinding(teamId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(bindingOpt)) return;
    const binding = bindingOpt.value;
    for (const provider of binding.providers) {
      const virtualId = makeTeamProviderInstanceId(teamId, provider.providerInstanceId);
      yield* cancelRenewalFiber(virtualId);
      yield* Ref.update(leasesRef, (current) => {
        if (!current.has(virtualId)) return current;
        const next = new Map(current);
        next.delete(virtualId);
        return next;
      });
      yield* purgeEphemeralLeaseTokens({
        stateDir: config.stateDir,
        teamId,
        virtualInstanceId: virtualId,
        driver: provider.driver,
      }).pipe(Effect.provideService(Digest.Digest, digest), Effect.provideService(Path.Path, path));
    }
  });

  const scheduleBackgroundRenewal = Effect.fn("TeamProviderManager.scheduleBackgroundRenewal")(
    function* (virtualInstanceId: ProviderInstanceId, expiresAtMs: number): Effect.fn.Return<void> {
      yield* cancelRenewalFiber(virtualInstanceId);
      const nowMs = yield* Clock.currentTimeMillis;
      const delayMs = Math.max(5_000, expiresAtMs - nowMs - TEAM_BACKGROUND_LEASE_RENEWAL_LEAD_MS);
      const fiber = yield* Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(
          requestFreshLease(virtualInstanceId, { forceRefresh: true }).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning("TeamProviderManager background lease renewal failed", {
                virtualInstanceId,
                errorTag: error._tag,
              }),
            ),
          ),
        ),
        Effect.forkIn(serviceScope),
      );
      yield* Ref.update(renewalFibersRef, (current) => {
        const next = new Map(current);
        next.set(virtualInstanceId, fiber);
        return next;
      });
    },
  );

  const requestFreshLease = Effect.fn("TeamProviderManager.requestFreshLease")(function* (
    virtualInstanceId: ProviderInstanceId,
    options?: { readonly forceRefresh?: boolean },
  ): Effect.fn.Return<
    { readonly lease: TeamProviderLeaseResponse; readonly rotated: boolean },
    TeamProviderAccessRevokedError | TeamProviderLeaseFetchError
  > {
    const parsed = parseTeamProviderInstanceId(virtualInstanceId);
    if (parsed === null) {
      return yield* new TeamProviderLeaseFetchError({
        teamId: TeamId.make("unknown"),
        instanceId: virtualInstanceId,
        detail: `Instance "${virtualInstanceId}" is not a virtual team provider instance.`,
      });
    }
    const { teamId, sourceInstanceId } = parsed;
    const bindingOpt = yield* assetsRepo.getLocalBinding(teamId).pipe(
      Effect.mapError(
        () =>
          new TeamProviderLeaseFetchError({
            teamId,
            instanceId: virtualInstanceId,
            detail: "Could not read local team binding.",
          }),
      ),
    );
    if (Option.isNone(bindingOpt)) {
      return yield* new TeamProviderLeaseFetchError({
        teamId,
        instanceId: virtualInstanceId,
        detail: `No local team binding found for team "${teamId}".`,
      });
    }
    const binding = bindingOpt.value;
    const provider = binding.providers.find((p) => p.providerInstanceId === sourceInstanceId);
    if (!provider || !provider.enabled || provider.deliveryStrategy !== "token-lease") {
      return yield* new TeamProviderLeaseFetchError({
        teamId,
        instanceId: virtualInstanceId,
        detail: `Provider "${sourceInstanceId}" is not an enabled token-lease provider for team "${binding.teamName}".`,
      });
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(leasesRef)).get(virtualInstanceId);
    if (
      options?.forceRefresh !== true &&
      cached !== undefined &&
      cached.expiresAtMs - nowMs >= TEAM_PRE_TURN_LEASE_RENEWAL_THRESHOLD_MS
    ) {
      return { lease: cached.lease, rotated: false };
    }

    const memberToken = yield* readLocalBindingToken(teamId, binding.tokenSecretKey);
    if (!memberToken) {
      return yield* new TeamProviderAccessRevokedError({
        teamId,
        instanceId: virtualInstanceId,
        detail: `Team credentials for "${binding.teamName}" are missing or revoked. Reconnect to the Team Server.`,
      });
    }

    const baseUrl = binding.teamServerUrl.replace(/\/+$/, "");
    const leaseUrl = `${baseUrl}/api/team/provider-lease/${encodeURIComponent(sourceInstanceId)}`;
    const req = HttpClientRequest.post(leaseUrl).pipe(
      HttpClientRequest.bearerToken(memberToken),
      HttpClientRequest.bodyText(
        encodeJsonUnknown({ forceRefresh: options?.forceRefresh === true }),
        "application/json",
      ),
    );

    const response = yield* httpClient.execute(req).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(
        () =>
          new TeamProviderLeaseFetchError({
            teamId,
            instanceId: virtualInstanceId,
            detail: `Could not reach Team Server "${binding.teamName}" to obtain a provider lease.`,
          }),
      ),
    );

    if (response.status === 403) {
      yield* purgeRevokedLocalTeam(teamId);
      return yield* new TeamProviderAccessRevokedError({
        teamId,
        instanceId: virtualInstanceId,
        detail: `Your access to team "${binding.teamName}" has been revoked. Ephemeral team credentials have been purged.`,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new TeamProviderLeaseFetchError({
        teamId,
        instanceId: virtualInstanceId,
        status: response.status,
        detail: `Team Server returned HTTP ${response.status} while issuing a lease for "${sourceInstanceId}".`,
      });
    }

    const decoded = yield* response.json.pipe(
      Effect.flatMap(decodeLeaseResponse),
      Effect.mapError(
        () =>
          new TeamProviderLeaseFetchError({
            teamId,
            instanceId: virtualInstanceId,
            detail: `Team Server returned an invalid lease response for "${sourceInstanceId}".`,
          }),
      ),
    );

    const lease: TeamProviderLeaseResponse = {
      providerInstanceId: decoded.providerInstanceId,
      driver: decoded.driver,
      accessToken: decoded.accessToken,
      tokenType: decoded.tokenType,
      expiresAt: decoded.expiresAt,
      expiresInSeconds: NonNegativeInt.make(Math.max(0, Math.floor(decoded.expiresInSeconds))),
      ...(decoded.email !== undefined ? { email: decoded.email } : {}),
      ...(decoded.authMethod !== undefined ? { authMethod: decoded.authMethod } : {}),
    };
    const parsedExpiryMs = Date.parse(lease.expiresAt);
    const expiresAtMs = Number.isFinite(parsedExpiryMs)
      ? parsedExpiryMs
      : nowMs + lease.expiresInSeconds * 1000;

    const rotated = cached === undefined || cached.lease.accessToken !== lease.accessToken;
    yield* Ref.update(leasesRef, (current) => {
      const next = new Map(current);
      next.set(virtualInstanceId, { lease, expiresAtMs, lastRefreshedAtMs: nowMs });
      return next;
    });

    yield* materializeEphemeralLeaseToken({
      stateDir: config.stateDir,
      teamId,
      virtualInstanceId,
      driver: provider.driver,
      lease,
    }).pipe(Effect.provideService(Digest.Digest, digest), Effect.provideService(Path.Path, path));

    yield* scheduleBackgroundRenewal(virtualInstanceId, expiresAtMs);
    return { lease, rotated };
  });

  const buildVirtualConfigForProvider = Effect.fn(
    "TeamProviderManager.buildVirtualConfigForProvider",
  )(function* (input: {
    readonly teamId: TeamId;
    readonly teamName: string;
    readonly provider: TeamProvider;
    readonly mode:
      | { readonly kind: "team-server"; readonly secretKey: string | null }
      | {
          readonly kind: "local-binding";
          readonly teamServerUrl: string;
          readonly memberToken: string | null;
        };
    readonly skills: ReadonlyArray<TeamSkill>;
    readonly preprompts: ReadonlyArray<TeamPreprompt>;
    readonly assetsRevision: number;
  }): Effect.fn.Return<{
    readonly virtualInstanceId: ProviderInstanceId;
    readonly config: ProviderInstanceConfig;
  } | null> {
    const { teamId, provider } = input;
    if (!provider.enabled) return null;
    // On a local environment, remote-only providers cannot execute locally.
    if (input.mode.kind === "local-binding" && provider.deliveryStrategy === "remote-only") {
      return null;
    }

    const virtualInstanceId = makeTeamProviderInstanceId(teamId, provider.providerInstanceId);
    const profilePaths = yield* materializeTeamProfileAssets({
      stateDir: config.stateDir,
      teamId,
      virtualInstanceId,
      driver: provider.driver,
      skills: input.skills,
      preprompts: input.preprompts,
      revision: input.assetsRevision,
    }).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const envVars: Array<{
      readonly name: string;
      readonly value: string;
      readonly sensitive: boolean;
    }> = [...buildStrippedAmbientEnv(provider.driver)];

    const baseConfig: Record<string, unknown> = { ...provider.config, enabled: true };

    if (provider.driver === "codex") {
      baseConfig.homePath = profilePaths.profileDir;
      envVars.push({ name: "CODEX_HOME", value: profilePaths.profileDir, sensitive: false });
      if (provider.deliveryStrategy === "token-lease") {
        baseConfig.setupMode = "managed";
      }
    } else if (provider.driver === "claudeAgent") {
      baseConfig.homePath = profilePaths.profileDir;
      envVars.push({ name: "CLAUDE_CONFIG_DIR", value: profilePaths.profileDir, sensitive: false });
    } else if (provider.driver === "antigravity") {
      envVars.push({ name: "GEMINI_HOME", value: profilePaths.profileDir, sensitive: false });
      envVars.push({ name: "AGY_ACP_FORCE_FILE_STORAGE", value: "1", sensitive: false });
      envVars.push({ name: "SSH_CONNECTION", value: "127.0.0.1 0 127.0.0.1 0", sensitive: false });
    } else {
      envVars.push({
        name: "T3_TEAM_PROFILE_DIR",
        value: profilePaths.profileDir,
        sensitive: false,
      });
      envVars.push({
        name: "T3_TEAM_SKILLS_DIR",
        value: profilePaths.skillsDir,
        sensitive: false,
      });
    }

    if (provider.deliveryStrategy === "proxy") {
      if (input.mode.kind === "local-binding") {
        const proxyBase = `${input.mode.teamServerUrl.replace(/\/+$/, "")}/api/team/provider-proxy/${encodeURIComponent(provider.providerInstanceId)}`;
        const memberToken = input.mode.memberToken ?? "";
        envVars.push(
          { name: "T3_TEAM_PROXY_URL", value: proxyBase, sensitive: false },
          { name: "T3_TEAM_PROXY_TOKEN", value: memberToken, sensitive: true },
          { name: "OPENAI_BASE_URL", value: proxyBase, sensitive: false },
          { name: "OPENAI_API_KEY", value: memberToken, sensitive: true },
          { name: "ANTHROPIC_BASE_URL", value: proxyBase, sensitive: false },
          { name: "ANTHROPIC_API_KEY", value: memberToken, sensitive: true },
          { name: "GOOGLE_GEMINI_BASE_URL", value: proxyBase, sensitive: false },
          { name: "GEMINI_API_KEY", value: memberToken, sensitive: true },
          { name: "GOOGLE_API_KEY", value: memberToken, sensitive: true },
        );
      } else if (provider.upstreamBaseUrl) {
        const secretPayload = input.mode.secretKey
          ? yield* readTeamProviderSecret(secrets, input.mode.secretKey).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
        const companyKey = secretPayload?.apiKey ?? "";
        envVars.push(
          { name: "T3_TEAM_PROXY_URL", value: provider.upstreamBaseUrl, sensitive: false },
          { name: "T3_TEAM_PROXY_TOKEN", value: companyKey, sensitive: true },
          { name: "OPENAI_BASE_URL", value: provider.upstreamBaseUrl, sensitive: false },
          { name: "OPENAI_API_KEY", value: companyKey, sensitive: true },
          { name: "ANTHROPIC_BASE_URL", value: provider.upstreamBaseUrl, sensitive: false },
          { name: "ANTHROPIC_API_KEY", value: companyKey, sensitive: true },
          { name: "GOOGLE_GEMINI_BASE_URL", value: provider.upstreamBaseUrl, sensitive: false },
          { name: "GEMINI_API_KEY", value: companyKey, sensitive: true },
          { name: "GOOGLE_API_KEY", value: companyKey, sensitive: true },
        );
      }
    }

    const displayName =
      provider.displayName ?? `${input.teamName} · ${provider.providerInstanceId}`;
    const instanceConfig: ProviderInstanceConfig = {
      driver: provider.driver,
      displayName,
      enabled: true,
      environment: envVars,
      config: baseConfig,
    };
    return { virtualInstanceId, config: instanceConfig };
  });

  const getVirtualProviderConfigs = Effect.fn("TeamProviderManager.getVirtualProviderConfigs")(
    function* (): Effect.fn.Return<ProviderInstanceConfigMap> {
      const result: Record<string, ProviderInstanceConfig> = {};

      // 1. Virtual providers for a Team Server workspace hosted locally on this process.
      const workspaceOpt = yield* teamRepo
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(workspaceOpt)) {
        const team = workspaceOpt.value;
        const [providers, skills, preprompts, assetsRevision] = yield* Effect.all([
          assetsRepo.listProviders(team.id).pipe(Effect.orElseSucceed(() => [])),
          assetsRepo.listSkills(team.id).pipe(Effect.orElseSucceed(() => [])),
          assetsRepo.listPreprompts(team.id).pipe(Effect.orElseSucceed(() => [])),
          assetsRepo.getAssetsRevision(team.id).pipe(Effect.orElseSucceed(() => 0)),
        ]);
        for (const stored of providers) {
          const built = yield* buildVirtualConfigForProvider({
            teamId: team.id,
            teamName: team.name,
            provider: TeamAssetsRepository.stripProviderSecretKey(stored),
            mode: { kind: "team-server", secretKey: stored.secretKey },
            skills,
            preprompts,
            assetsRevision,
          });
          if (built !== null) {
            result[built.virtualInstanceId] = built.config;
          }
        }
      }

      // 2. Virtual providers synced from remote Team Servers onto this local t3server.
      const bindings = yield* assetsRepo.listLocalBindings().pipe(Effect.orElseSucceed(() => []));
      for (const binding of bindings) {
        const memberToken = yield* readLocalBindingToken(binding.teamId, binding.tokenSecretKey);
        for (const provider of binding.providers) {
          const built = yield* buildVirtualConfigForProvider({
            teamId: binding.teamId,
            teamName: binding.teamName,
            provider,
            mode: {
              kind: "local-binding",
              teamServerUrl: binding.teamServerUrl,
              memberToken,
            },
            skills: binding.skills,
            preprompts: binding.preprompts,
            assetsRevision: binding.assetsRevision,
          });
          if (built !== null) {
            result[built.virtualInstanceId] = built.config;
          }
        }
      }

      return result as ProviderInstanceConfigMap;
    },
  );

  const syncLocalAssetsDelta = Effect.fn("TeamProviderManager.syncLocalAssetsDelta")(function* (
    teamId: TeamId,
    options?: { readonly targetRevision?: number; readonly forceFull?: boolean },
  ): Effect.fn.Return<number, TeamProviderAccessRevokedError> {
    const bindingOpt = yield* assetsRepo
      .getLocalBinding(teamId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(bindingOpt)) return 0;
    const binding = bindingOpt.value;
    if (
      options?.forceFull !== true &&
      options?.targetRevision !== undefined &&
      binding.assetsRevision >= options.targetRevision
    ) {
      return binding.assetsRevision;
    }

    const memberToken = yield* readLocalBindingToken(teamId, binding.tokenSecretKey);
    if (!memberToken) {
      return binding.assetsRevision;
    }

    const since = options?.forceFull === true ? 0 : binding.assetsRevision;
    const baseUrl = binding.teamServerUrl.replace(/\/+$/, "");
    const assetsUrl = `${baseUrl}/api/team/assets?since=${since}`;
    const response = yield* httpClient
      .execute(HttpClientRequest.get(assetsUrl).pipe(HttpClientRequest.bearerToken(memberToken)))
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      );
    if (response === null) {
      // Offline laptop fallback: keep cached materialized assets without blocking turn start.
      return binding.assetsRevision;
    }
    if (response.status === 403) {
      yield* purgeRevokedLocalTeam(teamId);
      return yield* new TeamProviderAccessRevokedError({
        teamId,
        instanceId: ProviderInstanceId.make(`team:${teamId}:revoked`),
        detail: `Your access to team "${binding.teamName}" has been revoked.`,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return binding.assetsRevision;
    }
    const deltaOpt = yield* response.json.pipe(
      Effect.flatMap(decodeAssetsDeltaResponse),
      Effect.option,
    );
    if (Option.isNone(deltaOpt)) {
      return binding.assetsRevision;
    }
    const delta = deltaOpt.value as unknown as TeamAssetsDeltaResponse;

    let nextSkills: ReadonlyArray<TeamSkill>;
    let nextPreprompts: ReadonlyArray<TeamPreprompt>;
    if (delta.fullSync) {
      nextSkills = delta.skills;
      nextPreprompts = delta.preprompts;
    } else {
      const deletedSkills = new Set<string>(delta.deletedSkillIds);
      const skillMap = new Map<string, TeamSkill>(
        binding.skills
          .filter((skill) => !deletedSkills.has(skill.id))
          .map((skill) => [skill.id, skill] as const),
      );
      for (const skill of delta.skills) {
        skillMap.set(skill.id, skill);
      }
      nextSkills = [...skillMap.values()];

      const deletedPreprompts = new Set<string>(delta.deletedPrepromptIds);
      const prepromptMap = new Map<string, TeamPreprompt>(
        binding.preprompts
          .filter((item) => !deletedPreprompts.has(item.id))
          .map((item) => [item.id, item] as const),
      );
      for (const item of delta.preprompts) {
        prepromptMap.set(item.id, item);
      }
      nextPreprompts = [...prepromptMap.values()];
    }

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* assetsRepo
      .updateLocalBindingAssets({
        teamId,
        skills: nextSkills,
        preprompts: nextPreprompts,
        assetsRevision: delta.revision,
        updatedAt: nowIso,
      })
      .pipe(Effect.ignore);

    const refreshedIds: Array<ProviderInstanceId> = [];
    for (const provider of binding.providers) {
      if (!provider.enabled || provider.deliveryStrategy === "remote-only") continue;
      const virtualId = makeTeamProviderInstanceId(teamId, provider.providerInstanceId);
      yield* materializeTeamProfileAssets({
        stateDir: config.stateDir,
        teamId,
        virtualInstanceId: virtualId,
        driver: provider.driver,
        skills: nextSkills,
        preprompts: nextPreprompts,
        revision: delta.revision,
      }).pipe(
        Effect.provideService(Digest.Digest, digest),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      refreshedIds.push(virtualId);
    }

    if (refreshedIds.length > 0) {
      yield* PubSub.publish(skillRefreshPubSub, refreshedIds);
    }
    return delta.revision;
  });

  const resolveTeamIdForProject = Effect.fn("TeamProviderManager.resolveTeamIdForProject")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly repoIdentityKey?: string | null;
    }): Effect.fn.Return<Option.Option<TeamId>> {
      const workspaceOpt = yield* teamRepo
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(workspaceOpt)) {
        const direct = yield* teamRepo
          .getProjectAssignment(input.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(direct)) {
          return Option.some(direct.value.teamId);
        }
        if (input.repoIdentityKey) {
          const allAssignments = yield* teamRepo
            .listProjectAssignments(workspaceOpt.value.id)
            .pipe(Effect.orElseSucceed(() => []));
          const byRepo = allAssignments.find(
            (assignment) => assignment.repoIdentityKey === input.repoIdentityKey,
          );
          if (byRepo !== undefined) {
            return Option.some(byRepo.teamId);
          }
        }
      }
      return yield* assetsRepo
        .findLocalTeamIdForProject({
          projectId: input.projectId,
          ...(input.repoIdentityKey !== undefined
            ? { repoIdentityKey: input.repoIdentityKey }
            : {}),
        })
        .pipe(Effect.orElseSucceed(() => Option.none()));
    },
  );

  const assertProviderAllowedForProject = Effect.fn(
    "TeamProviderManager.assertProviderAllowedForProject",
  )(function* (input: {
    readonly projectId: ProjectId;
    readonly repoIdentityKey?: string | null;
    readonly instanceId: ProviderInstanceId;
  }): Effect.fn.Return<void, TeamProviderIsolationError | TeamProviderRemoteOnlyError> {
    const teamIdOpt = yield* resolveTeamIdForProject({
      projectId: input.projectId,
      ...(input.repoIdentityKey !== undefined ? { repoIdentityKey: input.repoIdentityKey } : {}),
    });
    if (Option.isNone(teamIdOpt)) {
      return;
    }
    const teamId = teamIdOpt.value;
    if (!isTeamProviderInstanceIdForTeam(input.instanceId, teamId)) {
      return yield* new TeamProviderIsolationError({
        teamId,
        instanceId: input.instanceId,
        detail: `This project belongs to team "${teamId}" and can only run with team-configured providers (team:${teamId}:*). Personal provider credentials are strictly isolated.`,
      });
    }
    const parsed = parseTeamProviderInstanceId(input.instanceId)!;
    // Check if running on a local binding where this provider is marked remote-only or disabled.
    const bindingOpt = yield* assetsRepo
      .getLocalBinding(teamId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(bindingOpt)) {
      const matched = bindingOpt.value.providers.find(
        (p) => p.providerInstanceId === parsed.sourceInstanceId,
      );
      if (!matched || !matched.enabled) {
        return yield* new TeamProviderIsolationError({
          teamId,
          instanceId: input.instanceId,
          detail: `Provider "${parsed.sourceInstanceId}" is not enabled for team "${bindingOpt.value.teamName}".`,
        });
      }
      if (matched.deliveryStrategy === "remote-only") {
        return yield* new TeamProviderRemoteOnlyError({
          teamId,
          instanceId: input.instanceId,
          detail: `Provider "${matched.displayName ?? matched.providerInstanceId}" is remote-only and runs only on remote team environments.`,
        });
      }
      return;
    }
    // Check Team Server workspace provider table.
    const serverProviderOpt = yield* assetsRepo
      .getProviderByInstanceId(teamId, parsed.sourceInstanceId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(serverProviderOpt) || !serverProviderOpt.value.enabled) {
      return yield* new TeamProviderIsolationError({
        teamId,
        instanceId: input.instanceId,
        detail: `Provider "${parsed.sourceInstanceId}" is not enabled on the Team Server.`,
      });
    }
  });

  const resolvePrepromptsForTeamDriver = Effect.fn(
    "TeamProviderManager.resolvePrepromptsForTeamDriver",
  )(function* (input: {
    readonly teamId: TeamId;
    readonly driver: ProviderDriverKind;
    readonly nativeThreadHasTurns: boolean;
  }) {
    let preprompts: ReadonlyArray<TeamPreprompt> = [];
    const bindingOpt = yield* assetsRepo
      .getLocalBinding(input.teamId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(bindingOpt)) {
      preprompts = bindingOpt.value.preprompts;
    } else {
      preprompts = yield* assetsRepo
        .listPreprompts(input.teamId)
        .pipe(Effect.orElseSucceed(() => []));
    }

    const turnPreprompts = selectTeamPrepromptsForDriver(preprompts, input.driver, "turn");
    const turnPrepromptText = renderTeamPrepromptsMarkdown(turnPreprompts);

    const genericThreadPrepromptText =
      !input.nativeThreadHasTurns && !NATIVE_PROFILE_INSTRUCTION_DRIVERS.has(input.driver)
        ? renderTeamPrepromptsMarkdown(
            selectTeamPrepromptsForDriver(preprompts, input.driver, "thread"),
          )
        : "";

    return { turnPrepromptText, genericThreadPrepromptText };
  });

  const notifyTeamServerAssetsOrProvidersChanged = Effect.fn(
    "TeamProviderManager.notifyTeamServerAssetsOrProvidersChanged",
  )(function* () {
    const workspaceOpt = yield* teamRepo
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const refreshedIds: Array<ProviderInstanceId> = [];
    if (Option.isSome(workspaceOpt)) {
      const team = workspaceOpt.value;
      const [providers, skills, preprompts, assetsRevision] = yield* Effect.all([
        assetsRepo.listProviders(team.id).pipe(Effect.orElseSucceed(() => [])),
        assetsRepo.listSkills(team.id).pipe(Effect.orElseSucceed(() => [])),
        assetsRepo.listPreprompts(team.id).pipe(Effect.orElseSucceed(() => [])),
        assetsRepo.getAssetsRevision(team.id).pipe(Effect.orElseSucceed(() => 0)),
      ]);
      for (const stored of providers) {
        if (!stored.enabled) continue;
        const virtualId = makeTeamProviderInstanceId(team.id, stored.providerInstanceId);
        yield* materializeTeamProfileAssets({
          stateDir: config.stateDir,
          teamId: team.id,
          virtualInstanceId: virtualId,
          driver: stored.driver,
          skills,
          preprompts,
          revision: assetsRevision,
        }).pipe(
          Effect.provideService(Digest.Digest, digest),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        refreshedIds.push(virtualId);
      }
    }
    yield* PubSub.publish(virtualChangesPubSub, undefined);
    if (refreshedIds.length > 0) {
      yield* PubSub.publish(skillRefreshPubSub, refreshedIds);
    }
  });

  return TeamProviderManager.of({
    getVirtualProviderConfigs: getVirtualProviderConfigs(),
    get streamVirtualProviderChanges() {
      return Stream.fromPubSub(virtualChangesPubSub);
    },
    get streamSkillCatalogRefreshes() {
      return Stream.fromPubSub(skillRefreshPubSub);
    },
    notifyTeamServerAssetsOrProvidersChanged,

    syncLocalTeamBinding: Effect.fn("TeamProviderManager.syncLocalTeamBinding")(function* (input) {
      const existingOpt = yield* assetsRepo
        .getLocalBinding(input.teamId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const tokenSecretKey = localBindingTokenSecretKey(input.teamId);
      let effectiveSecretKey = Option.isSome(existingOpt) ? existingOpt.value.tokenSecretKey : null;
      if (input.memberToken !== undefined && input.memberToken.trim().length > 0) {
        yield* secrets
          .set(tokenSecretKey, textEncoder.encode(input.memberToken.trim()))
          .pipe(Effect.ignore);
        effectiveSecretKey = tokenSecretKey;
      }

      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const saved = yield* assetsRepo
        .upsertLocalBinding({
          teamId: input.teamId,
          teamName: input.teamName,
          teamServerUrl: input.teamServerUrl,
          tokenSecretKey: effectiveSecretKey,
          providers: input.providers,
          projects: input.projects,
          updatedAt: nowIso,
        })
        .pipe(Effect.orDie);

      // Purge any isolated profiles belonging to providers that were removed or disabled.
      if (Option.isSome(existingOpt)) {
        const nextIds = new Set(
          input.providers
            .filter((p) => p.enabled && p.deliveryStrategy !== "remote-only")
            .map((p) => p.providerInstanceId),
        );
        for (const prev of existingOpt.value.providers) {
          if (!nextIds.has(prev.providerInstanceId)) {
            const virtualId = makeTeamProviderInstanceId(input.teamId, prev.providerInstanceId);
            yield* cancelRenewalFiber(virtualId);
            yield* purgeTeamProfileDirectory({
              stateDir: config.stateDir,
              teamId: input.teamId,
              virtualInstanceId: virtualId,
              driver: prev.driver,
            }).pipe(
              Effect.provideService(Digest.Digest, digest),
              Effect.provideService(Path.Path, path),
            );
          }
        }
      }

      // Sync skills & preprompts delta whenever Team Server revision is ahead (or initial sync).
      let syncedRevision = saved.assetsRevision;
      if (input.assetsRevision > saved.assetsRevision || Option.isNone(existingOpt)) {
        syncedRevision = yield* syncLocalAssetsDelta(input.teamId, {
          targetRevision: input.assetsRevision,
          forceFull: Option.isNone(existingOpt),
        }).pipe(Effect.orElseSucceed(() => saved.assetsRevision));
      } else {
        // Ensure profiles are materialized for newly added providers even if assetsRevision did not bump.
        for (const provider of input.providers) {
          if (!provider.enabled || provider.deliveryStrategy === "remote-only") continue;
          const virtualId = makeTeamProviderInstanceId(input.teamId, provider.providerInstanceId);
          yield* materializeTeamProfileAssets({
            stateDir: config.stateDir,
            teamId: input.teamId,
            virtualInstanceId: virtualId,
            driver: provider.driver,
            skills: saved.skills,
            preprompts: saved.preprompts,
            revision: saved.assetsRevision,
          }).pipe(
            Effect.provideService(Digest.Digest, digest),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
        }
      }

      const virtualInstanceIds = input.providers
        .filter((p) => p.enabled && p.deliveryStrategy !== "remote-only")
        .map((p) => makeTeamProviderInstanceId(input.teamId, p.providerInstanceId));

      yield* PubSub.publish(virtualChangesPubSub, undefined);
      if (virtualInstanceIds.length > 0) {
        yield* PubSub.publish(skillRefreshPubSub, virtualInstanceIds);
      }

      return {
        synced: true,
        virtualInstanceIds,
        assetsRevision: NonNegativeInt.make(syncedRevision),
      } satisfies TeamSyncLocalBindingResult;
    }),

    removeLocalTeamBinding: Effect.fn("TeamProviderManager.removeLocalTeamBinding")(
      function* (teamId) {
        const deletedOpt = yield* assetsRepo
          .deleteLocalBinding(teamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(deletedOpt)) return false;
        const deleted = deletedOpt.value;
        if (deleted.tokenSecretKey) {
          yield* secrets.remove(deleted.tokenSecretKey).pipe(Effect.ignore);
        }
        for (const provider of deleted.providers) {
          const virtualId = makeTeamProviderInstanceId(teamId, provider.providerInstanceId);
          yield* cancelRenewalFiber(virtualId);
          yield* Ref.update(leasesRef, (current) => {
            if (!current.has(virtualId)) return current;
            const next = new Map(current);
            next.delete(virtualId);
            return next;
          });
          yield* purgeTeamProfileDirectory({
            stateDir: config.stateDir,
            teamId,
            virtualInstanceId: virtualId,
            driver: provider.driver,
          }).pipe(
            Effect.provideService(Digest.Digest, digest),
            Effect.provideService(Path.Path, path),
          );
        }
        yield* PubSub.publish(virtualChangesPubSub, undefined);
        return true;
      },
    ),

    syncLocalAssetsDelta,
    resolveTeamIdForProject,
    assertProviderAllowedForProject,

    prepareForTurn: Effect.fn("TeamProviderManager.prepareForTurn")(function* (input) {
      yield* assertProviderAllowedForProject({
        projectId: input.projectId,
        ...(input.repoIdentityKey !== undefined ? { repoIdentityKey: input.repoIdentityKey } : {}),
        instanceId: input.instanceId,
      });

      const teamIdOpt = yield* resolveTeamIdForProject({
        projectId: input.projectId,
        ...(input.repoIdentityKey !== undefined ? { repoIdentityKey: input.repoIdentityKey } : {}),
      });
      const parsedVirtual = parseTeamProviderInstanceId(input.instanceId);
      const effectiveTeamId = Option.isSome(teamIdOpt)
        ? teamIdOpt.value
        : (parsedVirtual?.teamId ?? null);

      if (effectiveTeamId === null) {
        return {
          teamId: null,
          recycleWarmSession: false,
          turnPrepromptText: "",
          genericThreadPrepromptText: "",
        };
      }

      let recycleWarmSession = false;
      if (parsedVirtual !== null) {
        const bindingOpt = yield* assetsRepo
          .getLocalBinding(effectiveTeamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(bindingOpt)) {
          // Pre-turn asset revision check catches up offline laptops transparently on reconnect.
          yield* syncLocalAssetsDelta(effectiveTeamId);
          const provider = bindingOpt.value.providers.find(
            (p) => p.providerInstanceId === parsedVirtual.sourceInstanceId,
          );
          if (provider?.deliveryStrategy === "token-lease") {
            const { rotated } = yield* requestFreshLease(input.instanceId);
            if (rotated && RAM_TOKEN_CACHING_DRIVERS.has(provider.driver)) {
              recycleWarmSession = true;
            }
          }
        }
      }

      const { turnPrepromptText, genericThreadPrepromptText } =
        yield* resolvePrepromptsForTeamDriver({
          teamId: effectiveTeamId,
          driver: input.driver,
          nativeThreadHasTurns: input.nativeThreadHasTurns,
        });

      return {
        teamId: effectiveTeamId,
        recycleWarmSession,
        turnPrepromptText,
        genericThreadPrepromptText,
      };
    }),

    getLeasedAccessToken: Effect.fn("TeamProviderManager.getLeasedAccessToken")(
      function* (virtualInstanceId, options) {
        const { lease } = yield* requestFreshLease(virtualInstanceId, options);
        return lease;
      },
    ),

    purgeEphemeralTokensForInstance: Effect.fn(
      "TeamProviderManager.purgeEphemeralTokensForInstance",
    )(function* (virtualInstanceId) {
      const parsed = parseTeamProviderInstanceId(virtualInstanceId);
      if (parsed === null) return;
      yield* cancelRenewalFiber(virtualInstanceId);
      yield* Ref.update(leasesRef, (current) => {
        if (!current.has(virtualInstanceId)) return current;
        const next = new Map(current);
        next.delete(virtualInstanceId);
        return next;
      });
      const bindingOpt = yield* assetsRepo
        .getLocalBinding(parsed.teamId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const driver = Option.isSome(bindingOpt)
        ? bindingOpt.value.providers.find((p) => p.providerInstanceId === parsed.sourceInstanceId)
            ?.driver
        : undefined;
      if (driver) {
        yield* purgeEphemeralLeaseTokens({
          stateDir: config.stateDir,
          teamId: parsed.teamId,
          virtualInstanceId,
          driver,
        }).pipe(
          Effect.provideService(Digest.Digest, digest),
          Effect.provideService(Path.Path, path),
        );
      }
    }),

    handleActiveTurnAuthFailure: Effect.fn("TeamProviderManager.handleActiveTurnAuthFailure")(
      function* (input) {
        const parsed = parseTeamProviderInstanceId(input.virtualInstanceId);
        if (parsed === null || !isAuthExpiryFailure(input.error)) {
          return { handled: false, revoked: false };
        }
        const bindingOpt = yield* assetsRepo
          .getLocalBinding(parsed.teamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(bindingOpt)) {
          return { handled: false, revoked: false };
        }
        const provider = bindingOpt.value.providers.find(
          (p) => p.providerInstanceId === parsed.sourceInstanceId,
        );
        if (!provider || provider.deliveryStrategy !== "token-lease") {
          return { handled: false, revoked: false };
        }

        const attemptKey = `${input.threadId}:${input.runId}`;
        const alreadyTried = yield* Ref.modify(autoResumedRunsRef, (current) => {
          if (current.has(attemptKey)) return [true, current] as const;
          const next = new Set(current);
          next.add(attemptKey);
          return [false, next] as const;
        });
        if (alreadyTried) {
          return { handled: false, revoked: false };
        }

        const refreshed = yield* Effect.result(
          requestFreshLease(input.virtualInstanceId, { forceRefresh: true }),
        );
        if (refreshed._tag === "Failure") {
          if (isTeamProviderAccessRevokedError(refreshed.failure)) {
            return {
              handled: true,
              revoked: true,
              message: refreshed.failure.message,
            };
          }
          return { handled: false, revoked: false };
        }

        // Recycle the RAM-caching child process so the continuation resumes via session/load with the new token.
        yield* input.recycleSession().pipe(Effect.ignore);

        const continuationReq: ProviderContinuationRequests.ProviderContinuationRequest = {
          driver: input.driver,
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          delivery: "message_text",
          detail: "Continue where you left off after refreshing the team provider session token.",
        };
        if (input.requestContinuation) {
          yield* input.requestContinuation(continuationReq);
        } else if (Option.isSome(continuationRequestsOption)) {
          yield* continuationRequestsOption.value.offer(continuationReq);
        }
        return { handled: true, revoked: false };
      },
    ),
  });
});

export const layer = Layer.effect(TeamProviderManager, make);

export const resolveTeamProfilePathsForTests = resolveTeamProfilePaths;
