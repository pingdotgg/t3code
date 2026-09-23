import { type HermesSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const HERMES_HOME_ENV = "HERMES_HOME";
const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
/**
 * Hard ceiling for the throwaway `resolveHermesAcpAuthMethodId` probe. It
 * runs inside `startSession`'s `withThreadLock`, so a hung `hermes acp`
 * process would otherwise orphan a child process and hold that thread's
 * lock forever.
 */
const HERMES_AUTH_METHOD_ID_PROBE_TIMEOUT_MS = 20_000;
/**
 * TTL for the module-scope `resolveHermesAcpAuthMethodId` cache. Every
 * `startSession` and every provider status check independently resolve the
 * auth method id; without caching each pays a full extra Hermes spawn
 * (~2s plugin load) purely to re-derive an id that changes only when the
 * user reconfigures Hermes's active provider.
 */
const HERMES_AUTH_METHOD_ID_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Bound (both the runtime's own internal wait and, mirrored, the adapter's
 * mid-turn steer wait — see `HermesAdapter.ts`'s steering branch) on how
 * long `session/cancel` waits for Hermes's real prompt response before
 * giving up. Hermes's ACP server does not reliably stop processing on
 * cancel, so `cancelBehavior: "wait-for-prompt"` is required here (unlike
 * the runtime's default "interrupt", which would synthesize an instant
 * `cancelled` result instead of ever observing Hermes's real response).
 */
export const HERMES_CANCEL_TIMEOUT_MS = 30_000;

interface CachedHermesAuthMethodId {
  readonly authMethodId: string;
  readonly expiresAtMs: number;
}

const hermesAuthMethodIdCache = new Map<string, CachedHermesAuthMethodId>();

function hermesAuthMethodIdCacheKey(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
): string {
  return `${hermesSettings?.binaryPath?.trim() ?? ""}::${hermesSettings?.homePath?.trim() ?? ""}`;
}

/** Test-only: clears the module-scope auth-method-id cache between focused test cases. */
export function resetHermesAcpAuthMethodIdCacheForTests(): void {
  hermesAuthMethodIdCache.clear();
}

/** Drops every expired entry. Called on each insert so the map never grows unbounded across (binaryPath, homePath) keys. */
function sweepExpiredHermesAuthMethodIdCacheEntries(nowMs: number): void {
  for (const [key, entry] of hermesAuthMethodIdCache) {
    if (entry.expiresAtMs <= nowMs) {
      hermesAuthMethodIdCache.delete(key);
    }
  }
}

/**
 * Drops the cached auth-method id for this (binaryPath, homePath) key, so
 * the next {@link resolveHermesAcpAuthMethodId} call re-probes Hermes
 * instead of reusing an id it has started rejecting (e.g. after the user
 * reconfigures Hermes's active provider).
 */
export function invalidateHermesAcpAuthMethodIdCache(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
): void {
  hermesAuthMethodIdCache.delete(hermesAuthMethodIdCacheKey(hermesSettings));
}

/**
 * True when `error` is the ACP client's own report that Hermes rejected the
 * `authenticate` call — the signal a cached auth-method id has gone stale,
 * as opposed to a spawn/initialize/network failure a retry cannot fix.
 */
export function isHermesAcpAuthenticateFailure(
  error: EffectAcpErrors.AcpError,
): error is EffectAcpErrors.AcpRequestError {
  return error._tag === "AcpRequestError" && error.method === "authenticate";
}

/**
 * Fallback ACP auth method id when Hermes's `initialize` response does not
 * advertise one. Matches the terminal setup method Hermes always offers
 * alongside its active provider's method
 * (`~/.hermes/cc-bridge` ACP server, verified live on hermes-agent 0.21.4).
 */
export const HERMES_TERMINAL_AUTH_METHOD_ID = "hermes-setup";

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath" | "homePath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Overrides the 20s production default for the auth-method probe; exposed only for focused tests. */
  readonly authMethodProbeTimeoutMs?: number;
}

/**
 * Hermes takes no runtime-mode-dependent CLI flags: permission behavior is
 * negotiated after the session starts through `session/set_mode`
 * (`default` | `accept_edits` | `dont_ask`), not spawn argv. Unlike Grok's
 * `grok agent stdio`, the only subcommand is `acp`.
 */
export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const homePath = hermesSettings?.homePath?.trim();
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    env: {
      ...environment,
      // Blank means "use Hermes's own default (~/.hermes)" — omit the
      // override entirely rather than sending an empty HERMES_HOME.
      ...(homePath ? { [HERMES_HOME_ENV]: homePath } : {}),
    },
  };
}

/**
 * Maps T3's runtime mode onto Hermes's three ACP session modes. Mirrors how
 * Grok pins Supervised onto argv so config cannot silently reopen
 * always-approve: Full access is the only mode that reaches `dont_ask`.
 */
export function resolveHermesAcpModeId(runtimeMode: RuntimeMode | undefined): string {
  switch (runtimeMode) {
    case "full-access":
      return "dont_ask";
    case "auto-accept-edits":
      return "accept_edits";
    default:
      return "default";
  }
}

/**
 * Discovers the auth method id to authenticate with. Hermes's `initialize`
 * response advertises the active provider's method first (dynamic — e.g.
 * `claude-subscription-directsdk-experimental` — and never to be hardcoded)
 * with the `hermes-setup` terminal method as a fallback. `session/prompt`
 * requires `authMethodId` before the session starts, so this opens and
 * closes a short-lived probe connection ahead of the real session spawn.
 */
const resolveHermesAcpAuthMethodIdUncached = (input: {
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Overrides the 20s production default; exposed only for focused tests. */
  readonly probeTimeoutMs?: number;
}): Effect.Effect<string, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* () {
    const probeScope = yield* Scope.make();
    const initializeResult = yield* Effect.gen(function* () {
      const acpContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
          cwd: input.cwd,
          clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
          authMethodId: HERMES_TERMINAL_AUTH_METHOD_ID,
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, probeScope));
      const probeRuntime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(acpContext),
      );
      return yield* probeRuntime.initialize();
    }).pipe(
      // Guaranteed child termination: interrupting on timeout unwinds this
      // fiber, which runs the `ensuring` finalizer below and closes
      // `probeScope` — tearing down every resource the layer acquired,
      // including the spawned `hermes acp` child process — before the
      // timeout error below is ever observed by the caller.
      Effect.ensuring(Scope.close(probeScope, Exit.void)),
      Effect.timeoutOrElse({
        duration: `${input.probeTimeoutMs ?? HERMES_AUTH_METHOD_ID_PROBE_TIMEOUT_MS} millis`,
        orElse: () =>
          new EffectAcpErrors.AcpTransportError({
            detail: `Hermes ACP auth-method probe did not respond to 'initialize' within ${input.probeTimeoutMs ?? HERMES_AUTH_METHOD_ID_PROBE_TIMEOUT_MS}ms.`,
            cause: "Hermes ACP auth-method probe timed out.",
          }),
      }),
    );

    const firstAuthMethodId = initializeResult.authMethods?.[0]?.id?.trim();
    return firstAuthMethodId && firstAuthMethodId.length > 0
      ? firstAuthMethodId
      : HERMES_TERMINAL_AUTH_METHOD_ID;
  });

/**
 * Cached wrapper around {@link resolveHermesAcpAuthMethodIdUncached}. The
 * resolved id only changes when the user reconfigures Hermes's active
 * provider, so every `startSession` and provider status check reusing it
 * within the TTL skips a full extra Hermes spawn (~2s plugin load).
 */
export const resolveHermesAcpAuthMethodId: typeof resolveHermesAcpAuthMethodIdUncached = (input) =>
  Effect.gen(function* () {
    const cacheKey = hermesAuthMethodIdCacheKey(input.hermesSettings);
    const cached = hermesAuthMethodIdCache.get(cacheKey);
    const nowMs = yield* Clock.currentTimeMillis;
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.authMethodId;
    }
    const authMethodId = yield* resolveHermesAcpAuthMethodIdUncached(input);
    sweepExpiredHermesAuthMethodIdCacheEntries(nowMs);
    hermesAuthMethodIdCache.set(cacheKey, {
      authMethodId,
      expiresAtMs: nowMs + HERMES_AUTH_METHOD_ID_CACHE_TTL_MS,
    });
    return authMethodId;
  });

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const authMethodId = yield* resolveHermesAcpAuthMethodId({
      hermesSettings: input.hermesSettings,
      cwd: input.cwd,
      ...(input.environment ? { environment: input.environment } : {}),
      childProcessSpawner: input.childProcessSpawner,
      ...(input.authMethodProbeTimeoutMs !== undefined
        ? { probeTimeoutMs: input.authMethodProbeTimeoutMs }
        : {}),
    });
    return yield* makeHermesAcpRuntimeForAuthMethodId(input, authMethodId);
  });

/** Builds the runtime for an already-resolved auth method id, skipping {@link resolveHermesAcpAuthMethodId} entirely — used by {@link withHermesAcpAuthRetry} so a retry's second attempt does not pay for a redundant resolution of the id it already has. */
const makeHermesAcpRuntimeForAuthMethodId = (
  input: HermesAcpRuntimeInput,
  authMethodId: string,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId,
        // Hermes's ACP server does not reliably stop processing a prompt
        // when it receives session/cancel (see HermesAdapter.ts's steering
        // branch), so the default "interrupt" behavior — which gives up
        // locally and synthesizes an instant `cancelled` result — would
        // hide that. "wait-for-prompt" makes cancel() genuinely wait for
        // Hermes's real response, bounded by cancelTimeout.
        cancelBehavior: "wait-for-prompt",
        cancelTimeout: `${HERMES_CANCEL_TIMEOUT_MS} millis`,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in Hermes slug. It stands in for "whatever model Hermes's
 * active provider currently runs" until the ACP session advertises real
 * model ids (e.g. `anthropic:claude-opus-4-8`) through `session/new`.
 */
export const HERMES_DEFAULT_MODEL_SLUG = "hermes-agent";

export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : HERMES_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, HERMES_DRIVER_KIND) ?? HERMES_DEFAULT_MODEL_SLUG;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Applies a requested model selection through `session/set_model`, skipping
 * the RPC when the requested id already matches the session's current
 * model, or when the placeholder slug (meaning "keep whatever Hermes is
 * currently running") was requested.
 */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId =
    input.requestedModelId === HERMES_DEFAULT_MODEL_SLUG ? undefined : input.requestedModelId;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

/**
 * Runs `attempt` against a Hermes ACP runtime built for the (possibly
 * cached) auth method id. If `attempt` fails specifically because Hermes
 * rejected `authenticate` — the signal a cached id has gone stale, e.g. the
 * user reconfigured Hermes's active provider since it was cached — the
 * cache entry is invalidated and `attempt` retried once against a freshly
 * re-probed id. Without this, a stale cached id fails every `startSession`
 * opaquely for up to the cache TTL. A non-authenticate failure (spawn,
 * initialize, network) is not retried, since a fresh probe cannot fix it.
 */
export const withHermesAcpAuthRetry = <A>(
  input: HermesAcpRuntimeInput,
  attempt: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ) => Effect.Effect<A, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope>,
): Effect.Effect<A, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* () {
    const probeInput = {
      hermesSettings: input.hermesSettings,
      cwd: input.cwd,
      ...(input.environment ? { environment: input.environment } : {}),
      childProcessSpawner: input.childProcessSpawner,
      ...(input.authMethodProbeTimeoutMs !== undefined
        ? { probeTimeoutMs: input.authMethodProbeTimeoutMs }
        : {}),
    };

    const firstAuthMethodId = yield* resolveHermesAcpAuthMethodId(probeInput);
    const firstResult = yield* Effect.result(
      makeHermesAcpRuntimeForAuthMethodId(input, firstAuthMethodId).pipe(Effect.flatMap(attempt)),
    );
    if (Result.isSuccess(firstResult)) {
      return firstResult.success;
    }
    if (!isHermesAcpAuthenticateFailure(firstResult.failure)) {
      return yield* firstResult.failure;
    }

    invalidateHermesAcpAuthMethodIdCache(input.hermesSettings);
    const secondAuthMethodId = yield* resolveHermesAcpAuthMethodId(probeInput);
    const secondResult = yield* Effect.result(
      makeHermesAcpRuntimeForAuthMethodId(input, secondAuthMethodId).pipe(Effect.flatMap(attempt)),
    );
    if (Result.isSuccess(secondResult)) {
      return secondResult.success;
    }
    if (!isHermesAcpAuthenticateFailure(secondResult.failure)) {
      return yield* secondResult.failure;
    }

    return yield* new EffectAcpErrors.AcpRequestError({
      code: secondResult.failure.code,
      errorMessage:
        `Hermes rejected authentication with both the cached auth method ` +
        `'${firstAuthMethodId}' and the freshly re-probed '${secondAuthMethodId}'. ` +
        `Check Hermes's active provider configuration.`,
      method: "authenticate",
      cause: secondResult.failure,
    });
  });
