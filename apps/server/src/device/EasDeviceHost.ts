/**
 * Cloud simulators from EAS Simulator. A device exists only while a session
 * runs, and every session bills the Expo account until it stops, so this host
 * bounds each one, stops all of them when it stops, and stops sessions a
 * previous server left behind. It never touches sessions it did not start.
 */
import {
  DeviceBootError,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type EasDeviceHostConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { findEasProjectId } from "./easProjectId.ts";
import { type ExpoApi, makeExpoApi, resolveExpoCredential } from "./ExpoApi.ts";

const POLL_INTERVAL = Duration.seconds(5);
// How stale a running session's status may get before listing rechecks it.
const STATUS_TTL_MS = 15_000;
// Expo's own CLI waits this long once a worker picks the session up.
const START_TIMEOUT = Duration.minutes(15);
const PREVIEW_TIMEOUT = Duration.seconds(20);
const SERVE_SIM_PREFIX = "/vendor/serve-sim";

/** EAS picks the simulator model; one entry starts a session. */
const CATALOG: ReadonlyArray<DeviceHost.HostDevice> = [
  {
    id: "eas-ios",
    platform: "ios",
    name: "iPhone (EAS Simulator)",
    version: "Cloud",
    booted: false,
    physical: false,
  },
];

interface RunningSession {
  readonly sessionId: string;
  readonly name: string;
  readonly udid: string;
  readonly preview: { readonly origin: string; readonly token: Redacted.Redacted<string> };
  readonly agent: DeviceHost.AgentDaemonEndpoint;
  /** Set once a stop has been asked for but Expo has not confirmed it. */
  stopping: boolean;
}

/**
 * Every session this host may have started, recorded by its unique name before
 * Expo is asked to create it, so a server that crashes at any point can still
 * find and stop the session on its next start.
 */
const LedgerEntry = Schema.Struct({
  name: Schema.String,
  appId: Schema.String,
  recordedAt: Schema.Number,
  /** Expo refused the create: nothing should run, but the reaper still looks. */
  refused: Schema.optional(Schema.Boolean),
});
type LedgerEntry = typeof LedgerEntry.Type;
const Ledger = Schema.fromJsonString(Schema.Array(LedgerEntry));
const decodeLedger = Schema.decodeUnknownEffect(Ledger);
const encodeLedger = Schema.encodeSync(Ledger);
// How often listing looks for recorded sessions this host no longer tracks.
const REAP_INTERVAL_MS = 60_000;
// Expo's ready queue is unbounded despite its 115-minute session limit and five-minute cleanup.
// Unlisted sessions stop counting after this lifetime; forget their records only once
// confirmed not running or after a day unconfirmed.
const RECORD_LIFETIME_MS = 180 * 60_000;
const RECORD_MAX_AGE_MS = 24 * 60 * 60_000;
// Expo lists a session it made within seconds; a create with an unknown
// outcome stops counting against the limit once it has had this long.
const UNCERTAIN_CREATE_MS = 5 * 60_000;
// One failed request to Expo during a minutes-long start does not end the start.
const TRANSIENT_RETRY = { times: 3, schedule: Schedule.spaced("2 seconds") } as const;
const decodePreviewApi = Schema.decodeUnknownEffect(Schema.Struct({ device: Schema.String }));

/** A malformed escape names no device, so the proxy answers 404 instead of failing. */
const decodePathSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const make = Effect.fn("EasDeviceHost.make")(function* (config: EasDeviceHostConfig) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | Effect.Services<ReturnType<typeof findEasProjectId>>
  >();
  const hostId = config.id;
  const ledgerPath = path.join(server.stateDir, "device", "eas", `${hostId}.json`);
  // Keyed by Expo's session id, which is also the device id: every EAS
  // simulator reports the same UDID, so the UDID cannot tell sessions apart.
  const sessions = new Map<string, RunningSession>();
  const checkedAt = new Map<string, number>();
  const startLock = yield* Semaphore.make(1);
  const ledgerLock = yield* Semaphore.make(1);
  // One sweep at a time: two would stop the same session twice.
  const reapLock = yield* Semaphore.make(1);
  // Starts run in the host rather than the caller: a client that disconnects
  // while a session boots leaves it running and tracked, and stopping or
  // closing the host interrupts the start, which then stops its session.
  const starts = yield* FiberSet.make<string, unknown>();
  // The startup sweep for recorded leftovers.
  const background = yield* FiberSet.make<void, never>();
  // Sessions this host owns that `sessions` does not hold: starts in progress,
  // and sessions whose stop after a failed start failed too. The reaper leaves
  // them alone and they count against the limit.
  const starting = new Set<string>();
  const unresolved = new Map<string, { readonly sessionId: string }>();
  // Creates whose outcome is unknown (no answer, or a server error), and
  // fresh records a previous server left: Expo may have made the session.
  // Each listing looks for it, and it counts against the limit until found
  // or until Expo would have listed it by now. The reaper handles these.
  const uncertain = new Map<string, { readonly entry: LedgerEntry; readonly until: number }>();
  const ownedNames = () =>
    new Set([
      ...[...sessions.values()].map((session) => session.name),
      ...starting,
      ...unresolved.keys(),
    ]);
  // Bumped whenever the host stops its sessions, so a start that finishes
  // afterwards stops its own session instead of leaving it untracked.
  let epoch = 0;
  // Set once the host's scope closes. A listing still running on this
  // instance then neither sweeps nor writes the ledger: a replacement with
  // the same id owns the sessions and the record now.
  let closed = false;
  let reapedAt = 0;
  let ready: DeviceHost.DeviceHostReady | null = null;

  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId,
      hostLabel: config.label,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const api: Effect.Effect<ExpoApi, DeviceHostUnavailableError> = resolveExpoCredential(
    config.accessToken,
  ).pipe(
    Effect.map((credential) => makeExpoApi(http, credential)),
    Effect.provide(services),
    Effect.mapError((error) => unavailable(error.message, error)),
  );

  /** A missing ledger is empty; an unreadable one is an error, never an empty list. */
  const readLedger = fs.readFileString(ledgerPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("[]"),
    ),
    Effect.flatMap(decodeLedger),
    Effect.mapError((cause) =>
      unavailable(
        `The record of running EAS sessions at ${ledgerPath} could not be read. Fix or remove it.`,
        cause,
      ),
    ),
  );
  const writeLedger = Effect.fn("EasDeviceHost.writeLedger")(function* (
    update: (entries: ReadonlyArray<LedgerEntry>) => ReadonlyArray<LedgerEntry>,
  ) {
    if (closed) return yield* unavailable(`${config.label} was replaced or removed.`);
    const entries = update(yield* readLedger);
    yield* writeFileStringAtomically({
      filePath: ledgerPath,
      contents: encodeLedger(entries),
    }).pipe(
      Effect.provide(services),
      Effect.mapError((cause) =>
        unavailable(
          `The record of running EAS sessions at ${ledgerPath} could not be written.`,
          cause,
        ),
      ),
    );
  }, ledgerLock.withPermit);
  const markRefused = (name: string) =>
    writeLedger((entries) =>
      entries.map((entry) => (entry.name === name ? { ...entry, refused: true } : entry)),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not update the EAS session record", { name, cause }),
      ),
    );
  const forgetEntry = (name: string) =>
    writeLedger((entries) => entries.filter((entry) => entry.name !== name)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not update the EAS session record", { name, cause }),
      ),
    );

  /** Stops a session and, once Expo confirms it, drops it from the ledger. */
  const stopSession = (expo: ExpoApi, sessionId: string, name: string) =>
    expo.stop(sessionId).pipe(
      Effect.andThen(forgetEntry(name)),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not stop EAS Simulator session", { sessionId, cause }),
      ),
    );

  /** Finds recorded sessions by name, so a session whose id never arrived is found too. */
  const stopRecorded = (expo: ExpoApi, entries: ReadonlyArray<LedgerEntry>) => {
    const found = new Set<string>();
    const listed = new Set<string>();
    return Effect.forEach(
      [...new Set(entries.map((entry) => entry.appId))],
      (appId) =>
        expo.activeSessions(appId).pipe(
          Effect.flatMap((active) =>
            Effect.forEach(
              entries.filter((entry) => entry.appId === appId),
              (entry) =>
                Effect.gen(function* () {
                  const running = active.filter((session) => session.name === entry.name);
                  if (running.length > 0) {
                    found.add(entry.name);
                    return yield* Effect.forEach(
                      running,
                      (session) =>
                        stopSession(expo, session.id, entry.name).pipe(
                          // Still running and billed: owned, counted, and retried by listing.
                          Effect.catch(() =>
                            Effect.sync(
                              () => void unresolved.set(entry.name, { sessionId: session.id }),
                            ),
                          ),
                        ),
                      { discard: true },
                    );
                  }
                }),
              { discard: true },
            ),
          ),
          Effect.tap(() => Effect.sync(() => void listed.add(appId))),
          Effect.ignore,
        ),
      { discard: true, concurrency: 4 },
    ).pipe(
      Effect.as({ found, listed } as {
        readonly found: ReadonlySet<string>;
        /** The apps whose listing succeeded; a failed one rules nothing out. */
        readonly listed: ReadonlySet<string>;
      }),
    );
  };

  /**
   * Retries the stop of a session whose stop failed. A session Expo already
   * ended is let go even if stopping it keeps failing.
   */
  const retryUnresolved = (expo: ExpoApi, name: string, sessionId: string) =>
    stopSession(expo, sessionId, name).pipe(
      Effect.catch(() =>
        expo
          .session(sessionId)
          .pipe(
            Effect.flatMap((current) =>
              current.status === "STOPPED" || current.status === "ERRORED"
                ? forgetEntry(name)
                : Effect.fail(current.status),
            ),
          ),
      ),
      Effect.andThen(Effect.sync(() => void unresolved.delete(name))),
      Effect.ignore,
    );

  /**
   * Records a previous server left count against the limit until a sweep
   * finds them (a fresh one until Expo would have listed it by now), so a
   * restart cannot start past it.
   */
  const adoptRecorded = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const owned = ownedNames();
    for (const entry of yield* readLedger) {
      const until = Math.max(entry.recordedAt + UNCERTAIN_CREATE_MS, now);
      // A refused create made nothing: its record is for the reaper only.
      if (!owned.has(entry.name) && !entry.refused) uncertain.set(entry.name, { entry, until });
    }
  }).pipe(Effect.ignore);

  /**
   * Stops recorded sessions this host does not own: a previous server's, or
   * a failed or uncertain start's. An uncertain one found (stopped, or
   * unresolved if that failed) or long enough unlisted frees its slot; its
   * record stays until it expires.
   */
  const reapLeftovers = Effect.fn("EasDeviceHost.reapLeftovers")(
    function* (expo: ExpoApi) {
      if (closed) return;
      reapedAt = yield* Clock.currentTimeMillis;
      const entries = yield* readLedger;
      const owned = ownedNames();
      const leftovers = entries.filter((entry) => !owned.has(entry.name));
      const { found, listed } = yield* stopRecorded(expo, leftovers);
      for (const [name, { entry, until }] of uncertain) {
        if (found.has(name) || (reapedAt >= until && listed.has(entry.appId))) {
          uncertain.delete(name);
        }
      }
      // Expo has ended these by now unless they waited in its queue: the slot
      // goes whatever the listing says (the app may be gone, or belong to
      // another account); the record goes once a listing confirms Expo does
      // not run it, or once no queue could have held it.
      for (const entry of leftovers) {
        const age = reapedAt - entry.recordedAt;
        if (age > RECORD_LIFETIME_MS) uncertain.delete(entry.name);
        if (found.has(entry.name)) continue;
        if ((age > RECORD_LIFETIME_MS && listed.has(entry.appId)) || age > RECORD_MAX_AGE_MS) {
          yield* forgetEntry(entry.name);
        }
      }
    },
    reapLock.withPermit,
    Effect.catch((cause) =>
      Effect.logWarning("Could not stop recorded EAS Simulator sessions", { cause }),
    ),
  );

  const previewDevice = (origin: string, token: Redacted.Redacted<string>) =>
    http
      .execute(
        HttpClientRequest.get(`${origin}/api`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodePreviewApi),
        Effect.map((api) => api.device),
        Effect.scoped,
        Effect.timeout(PREVIEW_TIMEOUT),
        Effect.retry(TRANSIENT_RETRY),
      );

  const awaitRunning = Effect.fn("EasDeviceHost.awaitRunning")(
    function* (expo: ExpoApi, sessionId: string) {
      for (;;) {
        const session = yield* expo.session(sessionId).pipe(
          Effect.retry(TRANSIENT_RETRY),
          Effect.mapError((error) => unavailable(error.message, error)),
        );
        if (session.status === "STOPPED" || session.status === "ERRORED") {
          return yield* new DeviceBootError({
            hostId,
            deviceId: sessionId,
            reason: "launch_failed",
            cause: new Error(`EAS Simulator session ended (${session.status}) before it was ready`),
          });
        }
        if (session.status === "IN_PROGRESS" && session.endpoints) return session.endpoints;
        yield* Effect.sleep(POLL_INTERVAL);
      }
    },
    (poll, _expo, sessionId) =>
      poll.pipe(
        Effect.timeoutOrElse({
          duration: START_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new DeviceBootError({
                hostId,
                deviceId: sessionId,
                reason: "timeout",
                cause: new Error("EAS Simulator session did not start in time"),
              }),
            ),
        }),
      ),
  );

  const reserveSlot = (name: string) =>
    startLock.withPermit(
      Effect.suspend(() => {
        const pending = unresolved.size + uncertain.size;
        if (sessions.size + starting.size + pending >= config.maxConcurrentSessions) {
          const limit = `${config.label} is limited to ${config.maxConcurrentSessions} running ${config.maxConcurrentSessions === 1 ? "session" : "sessions"}.`;
          return Effect.fail(
            unavailable(
              pending > 0
                ? `${limit} ${pending === 1 ? "A session" : `${pending} sessions`} that failed to start or stop ${pending === 1 ? "is" : "are"} still being cleaned up; try again shortly.`
                : `${limit} Close one in the Device panel first.`,
            ),
          );
        }
        starting.add(name);
        return Effect.void;
      }),
    );

  const startSession = Effect.fn("EasDeviceHost.startSession")(function* (
    device: DeviceHost.HostDevice,
    context: DeviceHost.DeviceOpenContext | undefined,
    startedIn: number,
  ) {
    const name = `T3 Code · ${config.label} · ${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0")}`;
    // The credential comes first: without one, the answer is how to sign in,
    // not that the limit is reached.
    const expo = yield* api;
    return yield* Effect.acquireUseRelease(
      reserveSlot(name),
      () =>
        Effect.gen(function* () {
          const appId =
            config.appId ??
            Option.getOrUndefined(
              context?.workspaceRoot
                ? yield* findEasProjectId(context.workspaceRoot).pipe(Effect.provide(services))
                : Option.none<string>(),
            );
          if (!appId) {
            return yield* unavailable(
              "No EAS project to run the session under. Choose one for this host in Settings, or open the device from a thread whose project names extra.eas.projectId in app.json or its app config.",
            );
          }
          const access = yield* expo
            .availability(appId)
            .pipe(Effect.mapError((error) => unavailable(error.message, error)));
          if (!access.available) {
            return yield* unavailable(
              `EAS Simulator is not enabled for the ${access.account} Expo account.`,
            );
          }
          const entry = { name, appId, recordedAt: yield* Clock.currentTimeMillis };
          // Recorded first: a session the ledger cannot hold is never started.
          yield* writeLedger((entries) => [...entries, entry]);
          if (epoch !== startedIn) {
            yield* forgetEntry(name);
            return yield* unavailable(`${config.label} was stopped while the session started.`);
          }
          // Create runs uninterrupted (Expo's API answers within 30 seconds) and
          // the stop below is in place before anything can interrupt the start,
          // so a session Expo made is always either tracked or stopped.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const sessionId = yield* expo
                .create({
                  appId,
                  platform: device.platform,
                  name,
                  maxRunTimeMinutes: config.maxSessionMinutes,
                  maxIdleTimeMinutes: config.idleMinutes,
                })
                .pipe(
                  // Unless Expo refused, it may have made the session before
                  // failing to answer. Unlisted, it stays counted for a while.
                  // Refused, it made nothing: the slot frees, but the record
                  // stays for the reaper in case the refusal was misread.
                  Effect.tapError((error) =>
                    error.rejected
                      ? stopRecorded(expo, [entry]).pipe(
                          Effect.flatMap(({ found }) =>
                            found.has(name) ? Effect.void : markRefused(name),
                          ),
                        )
                      : stopRecorded(expo, [entry]).pipe(
                          Effect.flatMap(({ found }) =>
                            found.has(name)
                              ? Effect.void
                              : Effect.map(Clock.currentTimeMillis, (now) => {
                                  uncertain.set(name, {
                                    entry,
                                    until: now + UNCERTAIN_CREATE_MS,
                                  });
                                }),
                          ),
                        ),
                  ),
                  Effect.mapError((error) => unavailable(error.message, error)),
                );
              return yield* restore(trackSession(expo, sessionId, name, startedIn)).pipe(
                Effect.onError(() =>
                  stopSession(expo, sessionId, name).pipe(
                    // Still running and billed: owned, counted, and retried by listing.
                    Effect.catch(() => Effect.sync(() => void unresolved.set(name, { sessionId }))),
                  ),
                ),
              );
            }),
          );
        }),
      () => Effect.sync(() => void starting.delete(name)),
    );
  });

  /** Waits for a created session and starts tracking it. */
  const trackSession = Effect.fn("EasDeviceHost.trackSession")(function* (
    expo: ExpoApi,
    sessionId: string,
    name: string,
    startedIn: number,
  ) {
    const endpoints = yield* awaitRunning(expo, sessionId);
    if (!endpoints.preview) {
      return yield* new DeviceBootError({
        hostId,
        deviceId: sessionId,
        reason: "launch_failed",
        cause: new Error("EAS Simulator returned no preview endpoint"),
      });
    }
    const origin = new URL(endpoints.preview.url).origin;
    const udid = yield* previewDevice(origin, endpoints.preview.token).pipe(
      Effect.mapError(
        (cause) =>
          new DeviceBootError({
            hostId,
            deviceId: sessionId,
            reason: "launch_failed",
            cause,
          }),
      ),
    );
    if (epoch !== startedIn) {
      return yield* unavailable(`${config.label} was stopped while the session started.`);
    }
    sessions.set(sessionId, {
      sessionId,
      name,
      udid,
      preview: { origin, token: endpoints.preview.token },
      agent: {
        baseUrl: endpoints.agentDevice.url,
        token: Redacted.value(endpoints.agentDevice.token),
      },
      stopping: false,
    });
    return sessionId;
  });

  const sessionFor = (deviceId: string) => Option.fromNullishOr(sessions.get(deviceId));

  const forget = (session: RunningSession) =>
    Effect.sync(() => {
      sessions.delete(session.sessionId);
      checkedAt.delete(session.sessionId);
    });

  /**
   * Expo ends sessions on its own at their run or idle limit; stop listing
   * those. A stop that failed earlier is retried, and recorded sessions nothing
   * tracks are reaped now and then.
   */
  const dropEnded = Effect.gen(function* () {
    if (closed) return;
    const now = yield* Clock.currentTimeMillis;
    const stale = [...sessions.values()].filter(
      (session) =>
        session.stopping || now - (checkedAt.get(session.sessionId) ?? 0) > STATUS_TTL_MS,
    );
    const reapDue = now - reapedAt > REAP_INTERVAL_MS;
    if (stale.length === 0 && unresolved.size === 0 && uncertain.size === 0 && !reapDue) return;
    const reap = reapDue || uncertain.size > 0;
    if (reap) reapedAt = now;
    const expo = yield* api.pipe(
      // Without a credential no sweep can look; a record Expo would have
      // listed by now still stops counting, so the limit is not held forever.
      Effect.tapError(() =>
        Effect.sync(() => {
          for (const [name, { until }] of uncertain) if (now >= until) uncertain.delete(name);
        }),
      ),
    );
    yield* Effect.forEach(
      [...unresolved],
      ([name, { sessionId }]) => retryUnresolved(expo, name, sessionId),
      { discard: true, concurrency: 4 },
    );
    yield* Effect.forEach(
      stale,
      (session) =>
        (session.stopping
          ? stopSession(expo, session.sessionId, session.name).pipe(
              Effect.andThen(forget(session)),
              // A session Expo already ended is let go even if stopping it keeps failing.
              Effect.catch(() =>
                expo
                  .session(session.sessionId)
                  .pipe(
                    Effect.flatMap((current) =>
                      current.status === "STOPPED" || current.status === "ERRORED"
                        ? forget(session).pipe(Effect.andThen(forgetEntry(session.name)))
                        : Effect.fail(current.status),
                    ),
                  ),
              ),
            )
          : expo
              .session(session.sessionId)
              .pipe(
                Effect.flatMap((current) =>
                  current.status === "STOPPED" || current.status === "ERRORED"
                    ? forget(session).pipe(Effect.andThen(forgetEntry(session.name)))
                    : Effect.sync(() => void checkedAt.set(session.sessionId, now)),
                ),
              )
        ).pipe(Effect.ignore),
      { discard: true, concurrency: 4 },
    );
    if (reap) yield* reapLeftovers(expo);
  }).pipe(Effect.ignore);

  /**
   * Stops a tracked session. Until Expo confirms, it stays tracked: listed,
   * counted against the limit, and retried by the next listing.
   */
  const stopTracked = (expo: ExpoApi, session: RunningSession) =>
    Effect.suspend(() => {
      session.stopping = true;
      return stopSession(expo, session.sessionId, session.name);
    }).pipe(Effect.andThen(forget(session)));

  const devices: DeviceHost.DeviceOperations = {
    list: dropEnded.pipe(
      Effect.andThen(
        Effect.sync(() => ({
          devices: [
            ...CATALOG,
            ...[...sessions.values()].map((session): DeviceHost.HostDevice => ({
              id: session.sessionId,
              platform: "ios",
              name: "iPhone (EAS Simulator)",
              version: "Cloud",
              booted: true,
              physical: false,
            })),
          ],
          detail: undefined,
        })),
      ),
    ),
    boot: (device, context) => {
      if (sessions.has(device.id)) return Effect.succeed(device.id);
      // Read before anything yields, so a stop that lands while the start
      // reads settings or files is seen.
      const startedIn = epoch;
      return startSession(device, context, startedIn).pipe(
        FiberSet.run(starts),
        Effect.flatMap(Fiber.await),
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
            ? Effect.fail(unavailable(`${config.label} was stopped while the session started.`))
            : exit,
        ),
      );
    },
    attach: () => Effect.void,
    shutdown: (device) =>
      Option.match(sessionFor(device.id), {
        onNone: () => Effect.void,
        onSome: (session) =>
          api.pipe(
            Effect.flatMap((expo) => stopTracked(expo, session)),
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new DeviceOperationError({
                  operation: "shutdown",
                  reason: "request_failed",
                  cause,
                }),
            ),
          ),
      }),
    screenshot: (device) =>
      Option.match(sessionFor(device.id), {
        onNone: () =>
          Effect.fail(
            new DeviceOperationError({
              operation: "screenshot",
              reason: "request_failed",
              cause: new Error("The EAS Simulator session is not running"),
            }),
          ),
        onSome: (session) =>
          http
            .execute(
              HttpClientRequest.post(
                `${session.preview.origin}/api/screenshot?device=${encodeURIComponent(session.udid)}`,
              ).pipe(HttpClientRequest.bearerToken(Redacted.value(session.preview.token))),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.scoped,
              Effect.timeout(PREVIEW_TIMEOUT),
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({
                    operation: "screenshot",
                    reason: "request_failed",
                    cause,
                  }),
              ),
            ),
      }),
    agentEndpoint: (deviceId) =>
      Option.match(sessionFor(deviceId), {
        onNone: () => Effect.fail(unavailable("This EAS Simulator device is no longer running.")),
        // agent-device selects the simulator by its UDID, not the session id T3 shows.
        onSome: (session) => Effect.succeed({ ...session.agent, agentDeviceId: session.udid }),
      }),
    endsDevices: true,
  };

  /**
   * serve-sim runs at the root of each session's preview host and wants its
   * token on every request. Clients name the device by its session id; serve-sim
   * knows it by its UDID, so the id is swapped for the UDID in the path and in
   * the `device` parameter.
   */
  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    Effect.sync(() => {
      if (!hubPath.startsWith(`${SERVE_SIM_PREFIX}/`)) return null;
      const helper = /^\/vendor\/serve-sim\/helper\/([^/]+)\//.exec(hubPath);
      const deviceId = helper ? decodePathSegment(helper[1]!) : search.get("device");
      if (helper && deviceId === null) return null;
      const session =
        deviceId !== null && deviceId !== undefined
          ? sessions.get(deviceId)
          : sessions.size === 1
            ? [...sessions.values()][0]
            : undefined;
      if (!session) return null;
      const path = helper
        ? `/helper/${encodeURIComponent(session.udid)}${hubPath.slice(helper[0].length - 1)}`
        : hubPath.slice(SERVE_SIM_PREFIX.length);
      const params = new URLSearchParams(search);
      if (params.has("device")) params.set("device", session.udid);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const token = Redacted.value(session.preview.token);
      return {
        url: `${session.preview.origin}${path}${query}`,
        headers: { authorization: `Bearer ${token}` },
        protocols: [`serve-sim.token.${token}`],
      };
    });

  const nodePath = yield* HostProcess.ExecutablePath;
  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = Effect.fn(
    "EasDeviceHost.ensureReady",
  )(function* () {
    if (ready) return ready;
    yield* adoptRecorded;
    // Without a credential the host is still ready: opening a device then
    // says how to sign in, and listing reaps once one is there.
    yield* FiberSet.run(background)(api.pipe(Effect.flatMap(reapLeftovers), Effect.ignore));
    ready = {
      nodePath,
      hub: { origin: "https://api.expo.dev" },
      devices,
      upstream,
      // Device settings run simctl on the simulator's own machine, which EAS does not expose.
      run: () =>
        Effect.succeed({
          stdout: "",
          stderr: "EAS Simulator devices cannot run host commands.",
          code: 127,
        }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    return ready;
  });

  // A session whose stop fails stays tracked for the next listing to retry,
  // and stays in the ledger for the next server if this one closes first.
  const stopAll = Effect.gen(function* () {
    epoch++;
    // Interrupted starts stop the sessions they created before this returns.
    yield* FiberSet.clear(starts);
    yield* FiberSet.clear(background);
    const expo = yield* api;
    yield* Effect.forEach(
      [...sessions.values()],
      (session) => stopTracked(expo, session).pipe(Effect.ignore),
      { discard: true, concurrency: 4 },
    );
    yield* Effect.forEach(
      [...unresolved],
      ([name, { sessionId }]) => retryUnresolved(expo, name, sessionId),
      { discard: true, concurrency: 4 },
    );
    // Also stop a recorded session a create with an unknown outcome made after all.
    yield* reapLeftovers(expo);
  }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() =>
    stopAll.pipe(
      // Under the ledger lock, so a write still in flight lands before a
      // replacement writes its own, which that write would overwrite.
      Effect.andThen(
        ledgerLock.withPermit(
          Effect.sync(() => {
            closed = true;
          }),
        ),
      ),
    ),
  );

  const platformAvailability = (platform: DevicePlatform) =>
    Effect.succeed(
      platform === "ios"
        ? { platform, available: true }
        : {
            platform,
            available: false,
            reason: "EAS Simulator Android emulators are not supported yet.",
          },
    );

  const summary: Effect.Effect<DeviceHostSummary> = Effect.all([
    platformAvailability("ios"),
    platformAvailability("android"),
  ]).pipe(
    Effect.map((platforms) => ({
      id: hostId,
      label: config.label,
      kind: "eas" as const,
      platforms,
      // Nothing to install: the hub and agent-device daemon run in each session.
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
  );

  return DeviceHost.DeviceHost.of({
    id: hostId,
    label: config.label,
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady: Effect.fn("DeviceHost.ensureAgentReady")(function (onPhase) {
      return ensureReady(onPhase).pipe(Effect.map((value) => ({ ...value, agentDevice: null })));
    }),
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    // Unlike machines the user owns, every running session here is billed.
    stop: stopAll,
  });
});
