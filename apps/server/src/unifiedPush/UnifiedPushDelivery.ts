import {
  type ThreadId,
  UnifiedPushRegistration,
  UnifiedPushRegistrationError,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

// The relay's pure payload and delivery helpers, shared with its standalone watcher script.
import { postUnifiedPush } from "../../../../infra/relay/src/agentActivity/unifiedPushSend.ts";
import { makeUnifiedPushWatch } from "../../../../infra/relay/src/agentActivity/unifiedPushWatch.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export const UNIFIED_PUSH_REGISTRATIONS_SECRET = "unified-push-registrations";

const Registrations = Schema.fromJsonString(Schema.Array(UnifiedPushRegistration));
const decodeRegistrations = Schema.decodeUnknownEffect(Registrations);
const encodeRegistrations = Schema.encodeEffect(Registrations);

export class UnifiedPushEndpointError extends Schema.TaggedError<UnifiedPushEndpointError>()(
  "UnifiedPushEndpointError",
  {},
) {
  override get message(): string {
    return "The UnifiedPush endpoint must be an http or https URL.";
  }
}

export class UnifiedPushRegistrationsSaveError extends Schema.TaggedError<UnifiedPushRegistrationsSaveError>()(
  "UnifiedPushRegistrationsSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save the UnifiedPush registrations.";
  }
}

/** The RPC error for a failed register or unregister; both messages are fixed text. */
export const toRegistrationError = (
  error: UnifiedPushEndpointError | UnifiedPushRegistrationsSaveError,
) => new UnifiedPushRegistrationError({ message: error.message });

/** Pushes this server's agent activity card to every phone registered over UnifiedPush. */
export class UnifiedPushDelivery extends Context.Service<
  UnifiedPushDelivery,
  {
    readonly register: (
      registration: UnifiedPushRegistration,
    ) => Effect.Effect<void, UnifiedPushEndpointError | UnifiedPushRegistrationsSaveError>;
    readonly unregister: (
      deviceId: string,
    ) => Effect.Effect<void, UnifiedPushRegistrationsSaveError>;
    /** Takes a thread's confirmed state; sends happen in the background, one queue per phone. */
    readonly publish: (
      threadId: ThreadId,
      state: RelayAgentActivityState | null,
    ) => Effect.Effect<void>;
  }
>()("t3/unifiedPush/UnifiedPushDelivery") {}

type Watch = ReturnType<typeof makeUnifiedPushWatch>;
type Message = NonNullable<ReturnType<Watch["applySnapshot"]>>;

interface Device {
  registration: UnifiedPushRegistration;
  watch: Watch;
  readonly outbox: Queue.Queue<Message>;
  readonly sender: Fiber.Fiber<void>;
}

const isWebUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const scope = yield* Effect.scope;
  // Serializes registration changes and their saves, so the last write holds the current list.
  const changes = yield* Semaphore.make(1);
  const states = new Map<ThreadId, RelayAgentActivityState>();
  const devices = new Map<string, Device>();

  const watchFor = (deviceId: string) =>
    makeUnifiedPushWatch({ deviceId, userId: "unifiedpush", source: environmentId });

  const save = Effect.suspend(() =>
    encodeRegistrations([...devices.values()].map((device) => device.registration)),
  ).pipe(
    Effect.flatMap((json) =>
      secrets.set(UNIFIED_PUSH_REGISTRATIONS_SECRET, new TextEncoder().encode(json)),
    ),
    Effect.mapError((cause) => new UnifiedPushRegistrationsSaveError({ cause })),
  );

  // Untraced: it loops for the device's lifetime; each post has its own span.
  const runSender = Effect.fnUntraced(function* (deviceId: string, outbox: Queue.Queue<Message>) {
    while (true) {
      const message = yield* Queue.take(outbox);
      const registration = devices.get(deviceId)?.registration;
      if (registration === undefined) return;
      const result = yield* postUnifiedPush(
        registration.endpoint,
        message.data,
        registration.keys,
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        // Its retries outlast its deadline, so this only satisfies the type.
        Effect.catchTags({
          UnifiedPushRetryableError: () => Effect.succeed({ outcome: "expired" } as const),
        }),
      );
      switch (result.outcome) {
        case "accepted":
          yield* Effect.logDebug("UnifiedPush delivered", { deviceId, label: message.label });
          break;
        case "gone": {
          // A re-registration during the post moved the device to a new endpoint; keep that one.
          const stopped = yield* changes.withPermits(1)(
            Effect.suspend(() => {
              if (devices.get(deviceId)?.registration.endpoint !== registration.endpoint) {
                return Effect.succeed(false);
              }
              devices.delete(deviceId);
              return save.pipe(
                Effect.catchTags({
                  UnifiedPushRegistrationsSaveError: (error) =>
                    Effect.logWarning(error.message, { deviceId }),
                }),
                Effect.as(true),
              );
            }),
          );
          if (!stopped) break;
          yield* Effect.logInfo("UnifiedPush subscription is gone; dropped its registration", {
            deviceId,
            status: result.status,
          });
          return;
        }
        case "rejected":
          yield* Effect.logWarning("UnifiedPush endpoint rejected a push", {
            deviceId,
            status: result.status,
          });
          break;
        case "unencryptable":
          yield* Effect.logWarning("UnifiedPush push could not be encrypted with the device keys", {
            deviceId,
          });
          break;
        case "expired":
          yield* Effect.logWarning("UnifiedPush push dropped after retrying", { deviceId });
          break;
      }
    }
  });

  // Untraced: it runs inside register's span, or once per saved device at startup.
  const startDevice = Effect.fnUntraced(function* (registration: UnifiedPushRegistration) {
    const outbox = yield* Queue.unbounded<Message>();
    const sender = yield* runSender(registration.deviceId, outbox).pipe(Effect.forkIn(scope));
    const device: Device = { registration, watch: watchFor(registration.deviceId), outbox, sender };
    return device;
  });

  const loaded = yield* secrets.get(UNIFIED_PUSH_REGISTRATIONS_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([]),
        onSome: (bytes) => decodeRegistrations(new TextDecoder().decode(bytes)),
      }),
    ),
    // Decode issues can quote the endpoint, which is a capability URL, so log only the tag.
    Effect.catch((error) =>
      Effect.logWarning("UnifiedPush registrations unreadable; starting without them", {
        error: error._tag,
      }).pipe(Effect.as([])),
    ),
  );
  for (const registration of loaded) {
    devices.set(registration.deviceId, yield* startDevice(registration));
  }

  const register: UnifiedPushDelivery["Service"]["register"] = Effect.fn(
    "UnifiedPushDelivery.register",
  )(function* (registration) {
    if (!isWebUrl(registration.endpoint)) return yield* new UnifiedPushEndpointError();
    yield* Effect.annotateCurrentSpan({ deviceId: registration.deviceId });
    yield* changes.withPermits(1)(
      Effect.gen(function* () {
        const device = devices.get(registration.deviceId) ?? (yield* startDevice(registration));
        const nowMs = yield* Clock.currentTimeMillis;
        // Decide and enqueue in one synchronous step, so publishes cannot slip in between.
        yield* Effect.sync(() => {
          device.registration = registration;
          // A fresh watch sends the current card, without an alert, as its first message.
          device.watch = watchFor(registration.deviceId);
          devices.set(registration.deviceId, device);
          const message = device.watch.applySnapshot(environmentId, [...states.values()], nowMs);
          if (message !== null) Queue.offerUnsafe(device.outbox, message);
        });
        yield* save;
      }),
    );
  });

  const unregister: UnifiedPushDelivery["Service"]["unregister"] = Effect.fn(
    "UnifiedPushDelivery.unregister",
  )(function* (deviceId) {
    yield* Effect.annotateCurrentSpan({ deviceId });
    // Always save, so a retry after a failed save still makes the removal durable.
    yield* changes.withPermits(1)(
      Effect.gen(function* () {
        const device = devices.get(deviceId);
        devices.delete(deviceId);
        if (device !== undefined) yield* Fiber.interrupt(device.sender);
        yield* save;
      }).pipe(Effect.uninterruptible),
    );
  });

  const publish: UnifiedPushDelivery["Service"]["publish"] = Effect.fn(
    "UnifiedPushDelivery.publish",
  )(function* (threadId, state) {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Effect.sync(() => {
      if (state === null) states.delete(threadId);
      else states.set(threadId, state);
      for (const device of devices.values()) {
        const message = device.watch.applyThreadUpdate(environmentId, threadId, state, nowMs);
        if (message !== null) Queue.offerUnsafe(device.outbox, message);
      }
    });
  });

  return UnifiedPushDelivery.of({ register, unregister, publish });
});

export const layer = Layer.effect(UnifiedPushDelivery, make);
