import {
  DirectPushDevice,
  DirectPushError,
  isListedThreadLineage,
  type DirectPushApsEnvironment,
  type DirectPushCredentialsInput,
  type DirectPushRegisterDeviceInput,
  type DirectPushStatus,
  type DirectPushTestResult,
  type DirectPushUnregisterDeviceInput,
  type ThreadId,
} from "@t3tools/contracts";
import {
  projectThreadAwarenessV2,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import * as DirectPushApns from "./DirectPushApns.ts";

const CREDENTIALS_SECRET = "direct-push-credentials";
const DEVICES_SECRET = "direct-push-devices";
// A run can end moments before its continuation starts; the relay holds completions as long.
const COMPLETION_HOLD = "5 seconds";
const MAX_ALERT_TEXT_LENGTH = 200;

const StoredCredentials = Schema.Struct({
  teamId: Schema.String,
  keyId: Schema.String,
  privateKey: Schema.String,
});
type StoredCredentials = typeof StoredCredentials.Type;

const StoredDevice = Schema.Struct({ ...DirectPushDevice.fields, token: Schema.String });
type StoredDevice = typeof StoredDevice.Type;
const StoredDevices = Schema.Array(StoredDevice);

const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCredentials));
const decodeDevices = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredDevices));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(StoredCredentials));
const encodeDevices = Schema.encodeEffect(Schema.fromJsonString(StoredDevices));

export type DirectPushAlertDecision = "alert" | "hold" | null;

const isAttention = (phase: AgentAwarenessPhase | undefined) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";
const isLive = (phase: AgentAwarenessPhase | undefined) =>
  phase !== undefined && phase !== "completed" && phase !== "failed";

/**
 * What a thread's move from `previous` to `next` should do. An unobserved thread is a baseline, so
 * a restart does not replay alerts; completions are held because a continuation may follow.
 */
export function directPushAlertFor(
  previous: AgentAwarenessPhase | undefined,
  next: AgentAwarenessPhase,
): DirectPushAlertDecision {
  if (previous === undefined || previous === next) return null;
  if (isAttention(next)) return isAttention(previous) ? null : "alert";
  if (next === "failed") return isLive(previous) ? "alert" : null;
  if (next === "completed") return isLive(previous) ? "hold" : null;
  return null;
}

const truncate = (value: string) =>
  value.length > MAX_ALERT_TEXT_LENGTH ? `${value.slice(0, MAX_ALERT_TEXT_LENGTH - 1)}…` : value;

function alertPayload(state: AgentAwarenessState): DirectPushApns.ApnsAlertPayload {
  return {
    aps: {
      alert: {
        title: truncate(state.threadTitle),
        body: truncate(`${state.headline}: ${state.projectTitle}`),
      },
      sound: "default",
      "thread-id": `${state.environmentId}/${state.threadId}`,
    },
    body: {
      environmentId: state.environmentId,
      threadId: state.threadId,
      deepLink: state.deepLink,
    },
  };
}

type DeliveryOutcome =
  | { readonly kind: "ok"; readonly environment: DirectPushApsEnvironment }
  | { readonly kind: "drop"; readonly error: string }
  | { readonly kind: "failed"; readonly error: string };

const describeResponse = (response: DirectPushApns.ApnsResponse) =>
  response.reason ?? `HTTP ${response.status}`;
const isOk = (response: DirectPushApns.ApnsResponse) =>
  response.status >= 200 && response.status < 300;
const isBadToken = (response: DirectPushApns.ApnsResponse) =>
  response.status === 400 && response.reason === "BadDeviceToken";

const storageError = (message: string) => new DirectPushError({ reason: "storage", message });

export class DirectPush extends Context.Service<
  DirectPush,
  {
    readonly registerDevice: (
      input: DirectPushRegisterDeviceInput,
    ) => Effect.Effect<void, DirectPushError>;
    readonly unregisterDevice: (
      input: DirectPushUnregisterDeviceInput,
    ) => Effect.Effect<void, DirectPushError>;
    readonly getStatus: Effect.Effect<DirectPushStatus>;
    readonly setCredentials: (
      input: DirectPushCredentialsInput,
    ) => Effect.Effect<DirectPushStatus, DirectPushError>;
    readonly clearCredentials: Effect.Effect<DirectPushStatus, DirectPushError>;
    readonly sendTest: Effect.Effect<DirectPushTestResult, DirectPushError>;
    /** Re-reads one thread and alerts on its transition; the domain event watcher calls it. */
    readonly observeThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** Waits for held completions and deliveries in flight. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/push/DirectPush") {}

/** @public */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const apns = yield* DirectPushApns.DirectPushApns;
  const writes = yield* Semaphore.make(1);
  const inFlight = yield* FiberSet.make<void, never>();

  const loadSecret = <A>(
    name: string,
    decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A | null> =>
    secrets.get(name).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: (bytes) => decode(new TextDecoder().decode(bytes)),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("direct push could not read its stored state", { name, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  let credentials = yield* loadSecret(CREDENTIALS_SECRET, decodeCredentials);
  let devices: ReadonlyArray<StoredDevice> =
    (yield* loadSecret(DEVICES_SECRET, decodeDevices)) ?? [];

  const saveDevices = (next: ReadonlyArray<StoredDevice>) =>
    encodeDevices(next).pipe(
      Effect.flatMap((text) => secrets.set(DEVICES_SECRET, new TextEncoder().encode(text))),
      Effect.tap(() => Effect.sync(() => void (devices = next))),
      Effect.tapCause((cause) =>
        Effect.logWarning("direct push could not save its devices", { cause }),
      ),
      Effect.mapError(() => storageError("Could not save the push device list.")),
    );

  const status = (): DirectPushStatus => ({
    credentials: credentials && { teamId: credentials.teamId, keyId: credentials.keyId },
    devices: devices.map(({ token: _token, ...device }) => device),
  });

  const enabled = () => credentials !== null && devices.length > 0;

  const registerDevice: DirectPush["Service"]["registerDevice"] = Effect.fn(
    "DirectPush.registerDevice",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "push.aps_environment": input.apsEnvironment });
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const existing = devices.find((device) => device.deviceId === input.deviceId);
        const sameToken = existing?.token === input.token ? existing : undefined;
        if (sameToken?.bundleId === input.bundleId && sameToken.label === input.label) return;
        // Keep the environment a delivery learned: the app keeps reporting its build's guess.
        const device: StoredDevice = {
          ...input,
          apsEnvironment: sameToken?.apsEnvironment ?? input.apsEnvironment,
          registeredAt: sameToken?.registeredAt ?? DateTime.formatIso(yield* DateTime.now),
          lastError: null,
        };
        // A reinstall keeps its token under a new id; the old entry would alert twice.
        yield* saveDevices([
          ...devices.filter(
            (entry) => entry.deviceId !== input.deviceId && entry.token !== input.token,
          ),
          device,
        ]);
        yield* Effect.logInfo("direct push device registered", {
          deviceId: input.deviceId,
          apsEnvironment: input.apsEnvironment,
        });
      }),
    );
  });

  const unregisterDevice: DirectPush["Service"]["unregisterDevice"] = Effect.fn(
    "DirectPush.unregisterDevice",
  )(function* (input) {
    yield* writes.withPermits(1)(
      Effect.suspend(() =>
        devices.some((device) => device.deviceId === input.deviceId)
          ? saveDevices(devices.filter((device) => device.deviceId !== input.deviceId))
          : Effect.void,
      ),
    );
  });

  const setCredentials: DirectPush["Service"]["setCredentials"] = Effect.fn(
    "DirectPush.setCredentials",
  )(function* (input) {
    yield* Effect.try({
      try: () => DirectPushApns.parseApnsPrivateKey(input.privateKey),
      catch: () =>
        new DirectPushError({
          reason: "invalid-credentials",
          message: "The key is not an APNs signing key. Paste the contents of the .p8 file.",
        }),
    });
    const next: StoredCredentials = { ...input };
    yield* writes.withPermits(1)(
      encodeCredentials(next).pipe(
        Effect.flatMap((text) => secrets.set(CREDENTIALS_SECRET, new TextEncoder().encode(text))),
        Effect.tapCause((cause) =>
          Effect.logWarning("direct push could not save its credentials", { cause }),
        ),
        Effect.mapError(() => storageError("Could not save the APNs key.")),
        Effect.tap(() => Effect.sync(() => void (credentials = next))),
      ),
    );
    return status();
  });

  const clearCredentials: DirectPush["Service"]["clearCredentials"] = Effect.gen(function* () {
    yield* writes.withPermits(1)(
      secrets.remove(CREDENTIALS_SECRET).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("direct push could not remove its credentials", { cause }),
        ),
        Effect.mapError(() => storageError("Could not remove the APNs key.")),
        Effect.tap(() => Effect.sync(() => void (credentials = null))),
      ),
    );
    return status();
  }).pipe(Effect.withSpan("DirectPush.clearCredentials"));

  const attempt = (
    activeCredentials: StoredCredentials,
    device: StoredDevice,
    environment: DirectPushApsEnvironment,
    payload: DirectPushApns.ApnsAlertPayload,
  ) =>
    apns
      .send({
        credentials: activeCredentials,
        environment,
        token: device.token,
        bundleId: device.bundleId,
        payload,
      })
      .pipe(
        Effect.catchTags({
          DirectPushApnsError: (error) =>
            Effect.logWarning("direct push delivery could not reach APNs", {
              deviceId: device.deviceId,
              environment,
              cause: error,
            }).pipe(Effect.as(error)),
        }),
      );

  // Untraced: one delivery per device per alert, under the broadcast's span.
  const deliver = Effect.fnUntraced(function* (
    activeCredentials: StoredCredentials,
    device: StoredDevice,
    payload: DirectPushApns.ApnsAlertPayload,
  ) {
    const first = yield* attempt(activeCredentials, device, device.apsEnvironment, payload);
    if (DirectPushApns.isDirectPushApnsError(first)) {
      return { kind: "failed", error: first.message } as const;
    }
    if (isOk(first)) return { kind: "ok", environment: device.apsEnvironment } as const;
    if (first.status === 410) return { kind: "drop", error: describeResponse(first) } as const;
    if (!isBadToken(first)) return { kind: "failed", error: describeResponse(first) } as const;
    // Xcode-signed builds carry sandbox tokens even when the app reports production.
    const other = device.apsEnvironment === "production" ? "sandbox" : "production";
    const second = yield* attempt(activeCredentials, device, other, payload);
    if (DirectPushApns.isDirectPushApnsError(second)) {
      return { kind: "failed", error: second.message } as const;
    }
    if (isOk(second)) return { kind: "ok", environment: other } as const;
    if (isBadToken(second) || second.status === 410) {
      return { kind: "drop", error: describeResponse(second) } as const;
    }
    return { kind: "failed", error: describeResponse(second) } as const;
  });

  const recordOutcome = (device: StoredDevice, outcome: DeliveryOutcome) =>
    writes
      .withPermits(1)(
        Effect.suspend(() => {
          // The device may have registered a new token while this delivery was in flight.
          const current = devices.find(
            (entry) => entry.deviceId === device.deviceId && entry.token === device.token,
          );
          if (current === undefined) return Effect.void;
          if (outcome.kind === "drop") {
            return Effect.logInfo("direct push dropped a device APNs no longer accepts", {
              deviceId: device.deviceId,
              reason: outcome.error,
            }).pipe(Effect.andThen(saveDevices(devices.filter((entry) => entry !== current))));
          }
          const updated: StoredDevice =
            outcome.kind === "ok"
              ? { ...current, apsEnvironment: outcome.environment, lastError: null }
              : { ...current, lastError: outcome.error };
          if (
            updated.apsEnvironment === current.apsEnvironment &&
            updated.lastError === current.lastError
          ) {
            return Effect.void;
          }
          return saveDevices(devices.map((entry) => (entry === current ? updated : entry)));
        }),
      )
      .pipe(Effect.ignore);

  const broadcast = Effect.fn("DirectPush.broadcast")(function* (
    payload: DirectPushApns.ApnsAlertPayload,
  ) {
    const activeCredentials = credentials;
    if (activeCredentials === null) return [];
    return yield* Effect.forEach(
      devices,
      (device) =>
        deliver(activeCredentials, device, payload).pipe(
          Effect.tap((outcome) => recordOutcome(device, outcome)),
          Effect.map((outcome) => ({ device, outcome })),
        ),
      { concurrency: 4 },
    );
  });

  const sendTest: DirectPush["Service"]["sendTest"] = Effect.gen(function* () {
    if (credentials === null) {
      return yield* new DirectPushError({
        reason: "not-configured",
        message: "Add an APNs key before sending a test notification.",
      });
    }
    const descriptor = yield* serverEnvironment.getDescriptor;
    const results = yield* broadcast({
      aps: {
        alert: { title: "T3 Code", body: `Test notification from ${descriptor.label}` },
        sound: "default",
        "thread-id": "t3-direct-push-test",
      },
    });
    return {
      deliveries: results.map(({ device, outcome }) => ({
        deviceId: device.deviceId,
        label: device.label,
        ok: outcome.kind === "ok",
        error: outcome.kind === "ok" ? null : outcome.error,
      })),
    };
  }).pipe(Effect.withSpan("DirectPush.sendTest"));

  const alert = (state: AgentAwarenessState) =>
    FiberSet.run(
      inFlight,
      broadcast(alertPayload(state)).pipe(
        Effect.tap((results) =>
          Effect.logInfo("direct push alert delivered", {
            threadId: state.threadId,
            phase: state.phase,
            delivered: results.filter((result) => result.outcome.kind === "ok").length,
            devices: results.length,
          }),
        ),
        Effect.asVoid,
      ),
    ).pipe(Effect.asVoid);

  // The per-event path below is untraced: it runs for every awareness-relevant domain event.
  const readAwareness = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = (yield* threads.getAgentAwarenessSnapshot(threadId)).threads[0] ?? null;
    if (thread !== null && !isListedThreadLineage(thread.lineage)) return undefined;
    if (thread === null || thread.archivedAt !== null) return null;
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return null;
    return projectThreadAwarenessV2({
      environmentId: yield* serverEnvironment.getEnvironmentId,
      project: project.value,
      thread,
    });
  });

  const lastPhase = new Map<ThreadId, AgentAwarenessPhase>();
  // Any newer phase replaces a thread's hold; ids are global so a stale hold never matches.
  const holds = new Map<ThreadId, number>();
  let nextHoldId = 0;

  const confirmCompletion = Effect.fnUntraced(function* (threadId: ThreadId, holdId: number) {
    yield* Effect.sleep(COMPLETION_HOLD);
    if (holds.get(threadId) !== holdId) return;
    holds.delete(threadId);
    if (!enabled()) return;
    const state = yield* readAwareness(threadId);
    if (state?.phase === "completed") yield* alert(state);
  });

  const observeThread: DirectPush["Service"]["observeThread"] = Effect.fnUntraced(
    function* (threadId: ThreadId) {
      if (!enabled()) {
        lastPhase.clear();
        holds.clear();
        return;
      }
      const state = yield* readAwareness(threadId);
      if (state === undefined) return;
      if (state === null) {
        lastPhase.delete(threadId);
        holds.delete(threadId);
        return;
      }
      const previous = lastPhase.get(threadId);
      if (previous === state.phase) return;
      lastPhase.set(threadId, state.phase);
      holds.delete(threadId);
      const decision = directPushAlertFor(previous, state.phase);
      if (decision === "alert") {
        yield* alert(state);
      } else if (decision === "hold") {
        const holdId = ++nextHoldId;
        holds.set(threadId, holdId);
        yield* FiberSet.run(
          inFlight,
          confirmCompletion(threadId, holdId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("direct push completion check failed", { threadId, cause }),
            ),
          ),
        );
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("direct push could not read thread activity", { threadId, cause }),
        ),
      ),
  );

  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      shouldPublishAgentAwarenessEvent(event) ? observeThread(event.threadId) : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("direct push stopped watching thread activity", { cause }),
      ),
    ),
  );

  return DirectPush.of({
    registerDevice,
    unregisterDevice,
    getStatus: Effect.sync(status),
    setCredentials,
    clearCredentials,
    sendTest,
    observeThread,
    drain: FiberSet.awaitEmpty(inFlight),
  });
});

export const layer = Layer.effect(DirectPush, make).pipe(Layer.provide(DirectPushApns.layer));
