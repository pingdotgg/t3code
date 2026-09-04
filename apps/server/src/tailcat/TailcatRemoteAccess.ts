import {
  AuthStandardClientScopes,
  type AuthSessionId,
  FEDERATION_PEER_CODE_PAIRING_SUBJECT,
  TAILCAT_CONNECTION_CODE_DEFAULT_TTL_SECONDS,
  TAILCAT_CONNECTION_CODE_PAIRING_SUBJECT,
  type TailcatAddress,
  type TailcatConnectionCodeResult,
  type TailcatCreateConnectionCodeInput,
  type TailcatFailure,
  type TailcatFailureCode,
  type TailcatNodeKey,
  TailcatRemoteAccessError,
  type TailcatRemoteAccessState,
  type TailcatRuntimeInfo,
  type TailcatServeStatus,
  TailcatTrustedPeer,
} from "@t3tools/contracts";
import { encodeTailcatConnectionCode } from "@t3tools/shared/t3ConnectionCode";
import { decodeTailcatAddress, tailcatKeyFingerprint } from "@t3tools/tailcat/address";
import { tailcatBackoffDelayMs } from "@t3tools/tailcat/backoff";
import {
  type TailcatRuntimeError,
  isTailcatRuntimeError,
  tailcatFailureCode,
} from "@t3tools/tailcat/errors";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/**
 * TailcatRemoteAccess makes this environment reachable over Tailcat.
 *
 * It owns one `tailcat serve` child that fronts the server's loopback listener,
 * the server's Tailcat identity (a key file in the secrets directory, so the
 * address is stable across restarts), and the list of trusted peers. Tailcat's
 * CLI takes its allowlist at startup, so the listener is restarted whenever the
 * trusted set changes:
 *
 *   - locked:  `--allow=<trusted node keys>` (or `none` while nobody is trusted)
 *   - open:    no allowlist while a connection code is active, so a new device
 *              can reach the T3 pairing endpoint; T3 auth still gates everything
 *
 * Pairing over Tailcat is the ordinary T3 pairing flow. The token exchange that
 * consumes a connection code reports the client's node key here, which adds it
 * to the trusted set; the next relock only admits trusted keys.
 */

const isTailcatRemoteAccessError = Schema.is(TailcatRemoteAccessError);

export const TAILCAT_REMOTE_ACCESS_STATE_FILE = "tailcat-remote-access.json";
export const TAILCAT_SERVER_IDENTITY_FILE = "tailcat-server-identity.private.json";
const RELOCK_DEBOUNCE = Duration.millis(1_500);
const EXPIRY_GRACE = Duration.seconds(1);

/** Pairing-link subjects whose active links open the Tailcat pairing window. */
const PAIRING_WINDOW_SUBJECTS: ReadonlySet<string> = new Set([
  TAILCAT_CONNECTION_CODE_PAIRING_SUBJECT,
  FEDERATION_PEER_CODE_PAIRING_SUBJECT,
]);

const PersistedTailcatRemoteAccess = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  trustedPeers: Schema.Array(TailcatTrustedPeer),
});
type PersistedTailcatRemoteAccess = typeof PersistedTailcatRemoteAccess.Type;

const PersistedTailcatRemoteAccessJson = Schema.fromJsonString(PersistedTailcatRemoteAccess);
const decodePersistedState = Schema.decodeUnknownEffect(PersistedTailcatRemoteAccessJson);
const encodePersistedState = Schema.encodeEffect(PersistedTailcatRemoteAccessJson);

const EMPTY_PERSISTED_STATE: PersistedTailcatRemoteAccess = {
  version: 1,
  enabled: false,
  trustedPeers: [],
};

export class TailcatRemoteAccess extends Context.Service<
  TailcatRemoteAccess,
  {
    readonly state: Effect.Effect<TailcatRemoteAccessState>;
    readonly changes: Stream.Stream<TailcatRemoteAccessState>;
    /** The address and port peers should dial while Tailcat access is enabled and serving. */
    readonly readyEndpoint: Effect.Effect<
      Option.Option<{ readonly address: TailcatAddress; readonly port: number }>
    >;
    /** Binds the service to the server's listening port and starts reconciling. */
    readonly start: (input: { readonly localPort: number }) => Effect.Effect<void>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<TailcatRemoteAccessState, TailcatRemoteAccessError>;
    readonly createConnectionCode: (
      input: TailcatCreateConnectionCodeInput,
    ) => Effect.Effect<TailcatConnectionCodeResult, TailcatRemoteAccessError>;
    /** Called by the token exchange that consumed a Tailcat connection code. */
    readonly recordTrustedPeer: (input: {
      readonly nodeKey: TailcatNodeKey;
      readonly label: string | undefined;
      /** The T3 session issued alongside the pairing, revoked with the peer. */
      readonly sessionId?: AuthSessionId;
    }) => Effect.Effect<void, TailcatRemoteAccessError>;
    readonly revokeTrustedPeer: (
      peerId: string,
    ) => Effect.Effect<TailcatRemoteAccessState, TailcatRemoteAccessError>;
    readonly renameTrustedPeer: (input: {
      readonly peerId: string;
      readonly label: string;
    }) => Effect.Effect<TailcatRemoteAccessState, TailcatRemoteAccessError>;
    readonly regenerateIdentity: Effect.Effect<TailcatRemoteAccessState, TailcatRemoteAccessError>;
  }
>()("t3/tailcat/TailcatRemoteAccess") {}

interface RunningServe {
  readonly scope: Scope.Closeable;
  readonly handle: TailcatRuntime.TailcatServeHandle;
  readonly allow: TailcatRuntime.TailcatAllowPolicy;
  readonly generation: number;
}

interface RuntimeState {
  readonly localPort: number | null;
  readonly running: RunningServe | null;
  readonly status: TailcatServeStatus;
  readonly address: TailcatAddress | null;
  readonly pairingOpen: boolean;
  readonly failures: number;
  readonly lastError: TailcatFailure | null;
  readonly runtime: TailcatRuntimeInfo | null;
  readonly generation: number;
}

const INITIAL_RUNTIME_STATE: RuntimeState = {
  localPort: null,
  running: null,
  status: "disabled",
  address: null,
  pairingOpen: false,
  failures: 0,
  lastError: null,
  runtime: null,
  generation: 0,
};

function allowPolicyEquals(
  left: TailcatRuntime.TailcatAllowPolicy,
  right: TailcatRuntime.TailcatAllowPolicy,
): boolean {
  if (left._tag !== right._tag) return false;
  if (left._tag === "keys" && right._tag === "keys") {
    const a = [...left.nodeKeys].sort();
    const b = [...right.nodeKeys].sort();
    return a.length === b.length && a.every((key, index) => key === b[index]);
  }
  return true;
}

function failureOf(
  error: TailcatRuntimeError | TailcatRemoteAccessError,
  at: string,
): TailcatFailure {
  if (isTailcatRuntimeError(error)) {
    return { code: tailcatFailureCode(error), message: error.message, at };
  }
  return { code: error.code, message: error.message, at };
}

const isPermanentFailure = (code: TailcatFailureCode): boolean =>
  code === "binary-missing" ||
  code === "binary-not-executable" ||
  code === "version-incompatible" ||
  code === "identity-failed";

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtime = yield* TailcatRuntime.TailcatRuntime;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Scope.Scope;

  const statePath = path.join(config.stateDir, TAILCAT_REMOTE_ACCESS_STATE_FILE);
  const identityPath = path.join(config.secretsDir, TAILCAT_SERVER_IDENTITY_FILE);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readPersisted = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw) || raw.value.trim().length === 0) {
      return EMPTY_PERSISTED_STATE;
    }
    return yield* decodePersistedState(raw.value).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Tailcat remote access state is unreadable; starting from defaults.", {
          statePath,
          cause,
        }).pipe(Effect.as(EMPTY_PERSISTED_STATE)),
      ),
    );
  });

  const persisted = yield* Ref.make<PersistedTailcatRemoteAccess>(yield* readPersisted);
  const runtimeState = yield* Ref.make<RuntimeState>(INITIAL_RUNTIME_STATE);
  const signals = yield* Queue.unbounded<"reconcile">();
  const expiryTimer = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  const retryTimer = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());

  const persistError = (cause: unknown) =>
    new TailcatRemoteAccessError({
      code: "unknown",
      message: `Could not save Tailcat remote access settings: ${String(cause)}`,
    });

  const writePersisted = (next: PersistedTailcatRemoteAccess) =>
    encodePersistedState(next).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }),
      ),
      Effect.mapError(persistError),
      Effect.andThen(Ref.set(persisted, next)),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const buildState = Effect.gen(function* () {
    const saved = yield* Ref.get(persisted);
    const current = yield* Ref.get(runtimeState);
    const fingerprint =
      current.address === null
        ? null
        : Result.match(decodeTailcatAddress(current.address), {
            onFailure: () => null,
            onSuccess: (decoded) => tailcatKeyFingerprint(decoded.serverNodeKey),
          });
    return {
      enabled: saved.enabled,
      status: current.status,
      address: current.address,
      remotePort: current.localPort,
      pairingOpen: current.pairingOpen,
      trustedPeers: saved.trustedPeers,
      runtime: current.runtime,
      identityFingerprint: fingerprint,
      lastError: current.lastError,
      updatedAt: yield* now,
    } satisfies TailcatRemoteAccessState;
  });

  const published = yield* SubscriptionRef.make<TailcatRemoteAccessState>(yield* buildState);
  const publish = buildState.pipe(Effect.flatMap((state) => SubscriptionRef.set(published, state)));

  const signalReconcile = Queue.offer(signals, "reconcile").pipe(Effect.asVoid);

  const listActiveConnectionCodes = pairingLinks.listActive().pipe(
    Effect.map((links) => links.filter((link) => PAIRING_WINDOW_SUBJECTS.has(link.subject))),
    Effect.catch((cause) =>
      Effect.logWarning("Could not list Tailcat connection codes; treating none as active.", {
        cause,
      }).pipe(Effect.as([])),
    ),
  );

  /**
   * The pairing window is derived, never stored: it is open exactly while an
   * unconsumed, unexpired connection code exists. Expiry does not emit a store
   * event, so a timer re-evaluates at the earliest expiry.
   */
  const refreshPairingWindow = Effect.gen(function* () {
    const active = yield* listActiveConnectionCodes;
    const open = active.length > 0;
    yield* Option.match(yield* Ref.getAndSet(expiryTimer, Option.none()), {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber),
    });
    if (open) {
      const currentMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      const earliestExpiry = Math.min(
        ...active.map((link) => DateTime.toEpochMillis(link.expiresAt)),
      );
      const delayMs = Math.max(0, earliestExpiry - currentMs) + Duration.toMillis(EXPIRY_GRACE);
      const fiber = yield* Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(signalReconcile),
        Effect.forkIn(serviceScope),
      );
      yield* Ref.set(expiryTimer, Option.some(fiber));
    }
    const previous = yield* Ref.get(runtimeState);
    yield* Ref.update(runtimeState, (current) => ({ ...current, pairingOpen: open }));
    return previous.pairingOpen !== open;
  });

  const ensureIdentity = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(identityPath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return;
    }
    yield* Effect.logInfo("Creating the Tailcat server identity.", { identityPath });
    yield* runtime.generateServerIdentity({ keyPath: identityPath });
  });

  const stopRunning = Effect.gen(function* () {
    const current = yield* Ref.get(runtimeState);
    if (current.running === null) {
      return;
    }
    yield* Ref.update(runtimeState, (state) => ({ ...state, running: null }));
    yield* Scope.close(current.running.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("Tailcat listener stopped.", { pid: current.running.handle.pid });
  });

  const desiredAllowPolicy = Effect.gen(function* () {
    const saved = yield* Ref.get(persisted);
    const current = yield* Ref.get(runtimeState);
    if (current.pairingOpen) {
      return { _tag: "all" } as const satisfies TailcatRuntime.TailcatAllowPolicy;
    }
    return {
      _tag: "keys",
      nodeKeys: saved.trustedPeers.map((peer) => peer.nodeKey),
    } as const satisfies TailcatRuntime.TailcatAllowPolicy;
  });

  const scheduleRetry = (failures: number) =>
    Effect.gen(function* () {
      yield* Option.match(yield* Ref.getAndSet(retryTimer, Option.none()), {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber),
      });
      const delayMs = tailcatBackoffDelayMs(failures, yield* Random.next);
      const fiber = yield* Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(signalReconcile),
        Effect.forkIn(serviceScope),
      );
      yield* Ref.set(retryTimer, Option.some(fiber));
    });

  const recordFailure = (error: TailcatRuntimeError | TailcatRemoteAccessError) =>
    Effect.gen(function* () {
      const at = yield* now;
      const failure = failureOf(error, at);
      const permanent = isPermanentFailure(failure.code);
      const next = yield* Ref.updateAndGet(runtimeState, (state) => ({
        ...state,
        status: permanent ? ("unavailable" as const) : ("error" as const),
        address: permanent ? null : state.address,
        failures: state.failures + 1,
        lastError: failure,
      }));
      yield* Effect.logWarning("Tailcat listener failed.", {
        code: failure.code,
        message: failure.message,
        failures: next.failures,
        permanent,
      });
      if (!permanent) {
        yield* scheduleRetry(next.failures);
      }
    });

  const startServe = (allow: TailcatRuntime.TailcatAllowPolicy, localPort: number) =>
    Effect.gen(function* () {
      const generation = (yield* Ref.get(runtimeState)).generation + 1;
      yield* Ref.update(runtimeState, (state) => ({
        ...state,
        generation,
        status: state.address === null ? ("starting" as const) : ("restarting" as const),
      }));
      yield* publish;
      const info = yield* runtime.resolve;
      yield* Ref.update(runtimeState, (state) => ({ ...state, runtime: info }));
      yield* ensureIdentity.pipe(
        Effect.mapError(
          (error) =>
            new TailcatRemoteAccessError({
              code: "identity-failed",
              message: `Could not prepare the Tailcat identity: ${error.message}`,
            }),
        ),
      );
      const scope = yield* Scope.make("sequential");
      const handle = yield* runtime.serve({ keyPath: identityPath, localPort, allow }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
      );
      const running: RunningServe = { scope, handle, allow, generation };
      yield* Ref.update(runtimeState, (state) => ({
        ...state,
        running,
        status: "ready" as const,
        address: handle.address,
        failures: 0,
        lastError: null,
      }));
      yield* Effect.logInfo("Tailcat listener ready.", {
        pid: handle.pid,
        localPort,
        allow: allow._tag,
        trustedPeerCount: allow._tag === "keys" ? allow.nodeKeys.length : null,
      });
      // Watch for an unexpected exit. A stop we initiated replaces `running`
      // first, so only a still-current generation schedules a restart.
      yield* handle.exit.pipe(
        Effect.flatMap((exitCode) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(runtimeState);
            if (current.running?.generation !== generation) {
              return;
            }
            const recentOutput = yield* handle.recentOutput;
            yield* Ref.update(runtimeState, (state) => ({ ...state, running: null }));
            yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
            yield* recordFailure(
              new TailcatRemoteAccessError({
                code: "process-exited",
                message:
                  recentOutput.at(-1) !== undefined
                    ? `The Tailcat listener exited (${Option.getOrNull(exitCode) ?? "signal"}): ${recentOutput.at(-1)}`
                    : `The Tailcat listener exited unexpectedly (${Option.getOrNull(exitCode) ?? "signal"}).`,
              }),
            );
            yield* publish;
          }),
        ),
        Effect.forkIn(serviceScope),
      );
    });

  const reconcile = Effect.gen(function* () {
    const saved = yield* Ref.get(persisted);
    const current = yield* Ref.get(runtimeState);
    if (current.localPort === null) {
      return;
    }
    if (!saved.enabled) {
      yield* stopRunning;
      yield* Ref.update(runtimeState, (state) => ({
        ...state,
        status: "disabled" as const,
        address: null,
        failures: 0,
        lastError: null,
      }));
      return;
    }
    const allow = yield* desiredAllowPolicy;
    if (current.running !== null && allowPolicyEquals(current.running.allow, allow)) {
      return;
    }
    if (current.running !== null) {
      yield* Effect.logInfo("Tailcat allowlist changed; restarting the listener.", {
        allow: allow._tag,
      });
      yield* stopRunning;
    }
    yield* startServe(allow, current.localPort).pipe(
      Effect.catch((error) =>
        isTailcatRuntimeError(error) || isTailcatRemoteAccessError(error)
          ? recordFailure(error)
          : Effect.die(error),
      ),
    );
  });

  const reconcileLoop = Effect.gen(function* () {
    for (;;) {
      yield* Queue.take(signals);
      // Coalesce bursts (a consumed code plus its recorded peer arrive together).
      yield* Effect.sleep(RELOCK_DEBOUNCE);
      yield* Queue.clear(signals);
      yield* refreshPairingWindow;
      yield* reconcile;
      yield* publish;
    }
  });
  yield* reconcileLoop.pipe(Effect.forkIn(serviceScope));

  yield* pairingLinks.streamChanges.pipe(
    Stream.filter(
      (change) =>
        change.type === "pairingLinkRemoved" ||
        PAIRING_WINDOW_SUBJECTS.has(change.pairingLink.subject),
    ),
    Stream.runForEach(() => signalReconcile),
    Effect.forkIn(serviceScope),
  );

  yield* Scope.addFinalizer(
    serviceScope,
    Effect.gen(function* () {
      const current = yield* Ref.get(runtimeState);
      if (current.running !== null) {
        yield* Scope.close(current.running.scope, Exit.void).pipe(Effect.ignore);
      }
    }),
  );

  const requireEnabledAndReady = Effect.gen(function* () {
    const saved = yield* Ref.get(persisted);
    const current = yield* Ref.get(runtimeState);
    if (!saved.enabled) {
      return yield* new TailcatRemoteAccessError({
        code: "unknown",
        message: "Enable Tailcat access before creating a connection code.",
      });
    }
    if (current.address === null || current.localPort === null) {
      return yield* new TailcatRemoteAccessError({
        code: current.lastError?.code ?? "startup-failed",
        message: current.lastError?.message ?? "Tailcat is still starting. Try again in a moment.",
      });
    }
    return { address: current.address, localPort: current.localPort };
  });

  const createConnectionCode: TailcatRemoteAccess["Service"]["createConnectionCode"] = Effect.fn(
    "TailcatRemoteAccess.createConnectionCode",
  )(function* (input) {
    const ready = yield* requireEnabledAndReady;
    const descriptor = yield* serverEnvironment.getDescriptor;
    const ttlSeconds = input.ttlSeconds ?? TAILCAT_CONNECTION_CODE_DEFAULT_TTL_SECONDS;
    const issued = yield* environmentAuth
      .createPairingLink({
        scopes: AuthStandardClientScopes,
        subject: TAILCAT_CONNECTION_CODE_PAIRING_SUBJECT,
        label: input.label ?? "Tailcat connection code",
        ttl: Duration.seconds(ttlSeconds),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TailcatRemoteAccessError({
              code: "unknown",
              message: `Could not issue a pairing credential: ${cause.message}`,
            }),
        ),
      );
    const expiresAt = DateTime.formatIso(issued.expiresAt);
    const payload = {
      v: 1 as const,
      transport: "tailcat" as const,
      address: ready.address,
      port: ready.localPort,
      environmentId: descriptor.environmentId,
      name: descriptor.label,
      serverVersion: descriptor.serverVersion,
      pairingToken: issued.credential,
      expiresAt,
    };
    // The window opens through the pairing-link change stream; nudge it so the
    // listener reopens without waiting for the debounce to notice on its own.
    yield* signalReconcile;
    yield* Effect.logInfo("Tailcat connection code issued.", {
      pairingLinkId: issued.id,
      expiresAt,
    });
    return {
      code: encodeTailcatConnectionCode(payload),
      payload,
      pairingLinkId: issued.id,
      expiresAt,
    } satisfies TailcatConnectionCodeResult;
  });

  const setEnabled: TailcatRemoteAccess["Service"]["setEnabled"] = Effect.fn(
    "TailcatRemoteAccess.setEnabled",
  )(function* (enabled) {
    const saved = yield* Ref.get(persisted);
    if (saved.enabled !== enabled) {
      yield* writePersisted({ ...saved, enabled });
      yield* Effect.logInfo(enabled ? "Tailcat access enabled." : "Tailcat access disabled.");
    }
    if (enabled) {
      // Clear a stale permanent failure so a retry actually happens after the
      // user installed or repaired the runtime.
      yield* Ref.update(runtimeState, (state) => ({ ...state, failures: 0 }));
      yield* runtime.refresh.pipe(Effect.ignore);
    }
    yield* signalReconcile;
    yield* publish;
    return yield* SubscriptionRef.get(published);
  });

  const recordTrustedPeer: TailcatRemoteAccess["Service"]["recordTrustedPeer"] = Effect.fn(
    "TailcatRemoteAccess.recordTrustedPeer",
  )(function* (input) {
    const saved = yield* Ref.get(persisted);
    const at = yield* now;
    const existing = saved.trustedPeers.find((peer) => peer.nodeKey === input.nodeKey);
    const label = input.label?.trim() || existing?.label || "Paired device";
    const sessionIds = input.sessionId === undefined ? [] : [input.sessionId];
    const peers = existing
      ? saved.trustedPeers.map((peer) =>
          peer.nodeKey === input.nodeKey
            ? {
                ...peer,
                label,
                lastSeenAt: at,
                sessionIds: [
                  ...peer.sessionIds,
                  ...sessionIds.filter((sessionId) => !peer.sessionIds.includes(sessionId)),
                ],
              }
            : peer,
        )
      : [
          ...saved.trustedPeers,
          {
            id: yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new TailcatRemoteAccessError({
                    code: "unknown",
                    message: `Could not allocate a peer id: ${String(cause)}`,
                  }),
              ),
            ),
            nodeKey: input.nodeKey,
            label,
            createdAt: at,
            lastSeenAt: at,
            sessionIds,
          },
        ];
    yield* writePersisted({ ...saved, trustedPeers: peers });
    yield* Effect.logInfo(existing ? "Tailcat peer re-paired." : "Tailcat peer trusted.", {
      fingerprint: tailcatKeyFingerprint(input.nodeKey),
      label,
    });
    yield* signalReconcile;
    yield* publish;
  });

  const revokeTrustedPeer: TailcatRemoteAccess["Service"]["revokeTrustedPeer"] = Effect.fn(
    "TailcatRemoteAccess.revokeTrustedPeer",
  )(function* (peerId) {
    const saved = yield* Ref.get(persisted);
    const peer = saved.trustedPeers.find((candidate) => candidate.id === peerId);
    if (peer === undefined) {
      return yield* new TailcatRemoteAccessError({
        code: "unknown",
        message: "That device is no longer in the trusted list.",
      });
    }
    yield* writePersisted({
      ...saved,
      trustedPeers: saved.trustedPeers.filter((candidate) => candidate.id !== peerId),
    });
    yield* Effect.forEach(
      peer.sessionIds,
      (sessionId) => environmentAuth.revokeSession(sessionId).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Effect.logInfo("Tailcat peer revoked.", {
      fingerprint: tailcatKeyFingerprint(peer.nodeKey),
      revokedSessions: peer.sessionIds.length,
    });
    yield* signalReconcile;
    yield* publish;
    return yield* SubscriptionRef.get(published);
  });

  const renameTrustedPeer: TailcatRemoteAccess["Service"]["renameTrustedPeer"] = Effect.fn(
    "TailcatRemoteAccess.renameTrustedPeer",
  )(function* ({ peerId, label }) {
    const saved = yield* Ref.get(persisted);
    if (!saved.trustedPeers.some((peer) => peer.id === peerId)) {
      return yield* new TailcatRemoteAccessError({
        code: "unknown",
        message: "That device is no longer in the trusted list.",
      });
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      return yield* new TailcatRemoteAccessError({
        code: "unknown",
        message: "A device name cannot be empty.",
      });
    }
    yield* writePersisted({
      ...saved,
      trustedPeers: saved.trustedPeers.map((peer) =>
        peer.id === peerId ? { ...peer, label: trimmed } : peer,
      ),
    });
    yield* publish;
    return yield* SubscriptionRef.get(published);
  });

  const regenerateIdentity: TailcatRemoteAccess["Service"]["regenerateIdentity"] = Effect.gen(
    function* () {
      yield* stopRunning;
      yield* fileSystem.remove(identityPath, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new TailcatRemoteAccessError({
              code: "identity-failed",
              message: `Could not remove the previous Tailcat identity: ${String(cause)}`,
            }),
        ),
      );
      yield* Ref.update(runtimeState, (state) => ({
        ...state,
        address: null,
        failures: 0,
        lastError: null,
      }));
      yield* Effect.logInfo("Tailcat identity regenerated; connected devices must re-pair.");
      yield* signalReconcile;
      yield* publish;
      return yield* SubscriptionRef.get(published);
    },
  ).pipe(Effect.withSpan("TailcatRemoteAccess.regenerateIdentity"));

  const start: TailcatRemoteAccess["Service"]["start"] = Effect.fn("TailcatRemoteAccess.start")(
    function* ({ localPort }) {
      const current = yield* Ref.get(runtimeState);
      if (current.localPort !== null) {
        return;
      }
      yield* Ref.update(runtimeState, (state) => ({ ...state, localPort }));
      if (config.tailcatEnabled === true) {
        const saved = yield* Ref.get(persisted);
        if (!saved.enabled) {
          yield* writePersisted({ ...saved, enabled: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not persist the Tailcat enable flag.", { error }),
            ),
          );
        }
      }
      yield* signalReconcile;
    },
  );

  return TailcatRemoteAccess.of({
    readyEndpoint: Effect.gen(function* () {
      const current = yield* Ref.get(runtimeState);
      const saved = yield* Ref.get(persisted);
      // Only while the listener is up (or bouncing for a relock): a failed or
      // unavailable listener must not be advertised in codes.
      const serving = current.status === "ready" || current.status === "restarting";
      return saved.enabled && serving && current.address !== null && current.localPort !== null
        ? Option.some({ address: current.address, port: current.localPort })
        : Option.none();
    }),
    state: SubscriptionRef.get(published),
    changes: SubscriptionRef.changes(published),
    start,
    setEnabled,
    createConnectionCode,
    recordTrustedPeer,
    revokeTrustedPeer,
    renameTrustedPeer,
    regenerateIdentity,
  });
});

export const layer = Layer.effect(TailcatRemoteAccess, make);
