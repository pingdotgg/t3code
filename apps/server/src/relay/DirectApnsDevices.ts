import { PushDeviceRegistration, PushLiveActivityRegistration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export type StoredPushDevice = PushDeviceRegistration;
export type StoredLiveActivity = PushLiveActivityRegistration;

// APNs device tokens are bearer-like identifiers for pushing to a phone, so
// they live in the secret store (mode-600 files in a mode-700 directory)
// rather than in settings.json or the database.
const DEVICES_SECRET = "direct-apns-devices";
const LIVE_ACTIVITIES_SECRET = "direct-apns-live-activities";

export class DirectApnsDevices extends Context.Service<
  DirectApnsDevices,
  {
    readonly register: (
      device: PushDeviceRegistration,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly unregister: (
      deviceId: string,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly list: Effect.Effect<
      ReadonlyArray<StoredPushDevice>,
      ServerSecretStore.SecretStoreError
    >;
    readonly registerLiveActivity: (
      activity: PushLiveActivityRegistration,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly unregisterLiveActivity: (
      deviceId: string,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly listLiveActivities: Effect.Effect<
      ReadonlyArray<StoredLiveActivity>,
      ServerSecretStore.SecretStoreError
    >;
    /** Drops a live activity token APNs rejected or that ended; a newer token for the device survives. */
    readonly removeLiveActivityToken: (input: {
      readonly deviceId: string;
      readonly token: string;
    }) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    /** Drops a token APNs rejected, unless the device has since registered a new one. */
    readonly removeRejectedToken: (input: {
      readonly deviceId: string;
      readonly apnsToken: string;
    }) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
  }
>()("t3/relay/DirectApnsDevices") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Registrations, unregistrations and APNs rejections all rewrite one file.
  const lock = yield* Semaphore.make(1);

  const makeStore = <A extends { readonly deviceId: string }, I>(
    secretName: string,
    item: Schema.Codec<A, I>,
  ) => {
    const json = Schema.fromJsonString(Schema.Array(item));
    const decode = Schema.decodeUnknownEffect(json);
    const encode = Schema.encodeEffect(json);
    const read = secrets.get(secretName).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<ReadonlyArray<A>>([]),
          onSome: (bytes) =>
            decode(new TextDecoder().decode(bytes)).pipe(
              // A corrupt file must not block registering a fresh token.
              Effect.orElseSucceed((): ReadonlyArray<A> => []),
            ),
        }),
      ),
    );
    const modify = (change: (items: ReadonlyArray<A>) => ReadonlyArray<A>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* read;
          const next = change(current);
          if (next.length === current.length && next.every((entry, i) => entry === current[i])) {
            return;
          }
          const encoded = yield* encode(next).pipe(Effect.orDie);
          yield* secrets.set(secretName, new TextEncoder().encode(encoded));
        }),
      );
    return {
      read,
      modify,
      upsert: (entry: A) =>
        modify((items) => [...items.filter((e) => e.deviceId !== entry.deviceId), entry]),
      remove: (deviceId: string) => modify((items) => items.filter((e) => e.deviceId !== deviceId)),
    };
  };

  const devices = makeStore(DEVICES_SECRET, PushDeviceRegistration);
  const liveActivities = makeStore(LIVE_ACTIVITIES_SECRET, PushLiveActivityRegistration);

  return DirectApnsDevices.of({
    register: Effect.fn("DirectApnsDevices.register")(function* (device) {
      yield* devices.upsert(device);
    }),
    unregister: Effect.fn("DirectApnsDevices.unregister")(function* (deviceId) {
      yield* devices.remove(deviceId);
    }),
    list: lock.withPermits(1)(devices.read),
    registerLiveActivity: Effect.fn("DirectApnsDevices.registerLiveActivity")(function* (entry) {
      yield* liveActivities.upsert(entry);
    }),
    unregisterLiveActivity: Effect.fn("DirectApnsDevices.unregisterLiveActivity")(
      function* (deviceId) {
        yield* liveActivities.remove(deviceId);
      },
    ),
    listLiveActivities: lock.withPermits(1)(liveActivities.read),
    removeLiveActivityToken: Effect.fn("DirectApnsDevices.removeLiveActivityToken")(
      function* (input) {
        yield* liveActivities.modify((items) =>
          items.flatMap((entry) => {
            if (entry.deviceId !== input.deviceId) return [entry];
            const { activityPushToken, pushToStartToken, ...rest } = entry;
            const next = {
              ...rest,
              ...(activityPushToken !== input.token ? { activityPushToken } : {}),
              ...(pushToStartToken !== input.token ? { pushToStartToken } : {}),
            };
            return next.activityPushToken || next.pushToStartToken ? [next] : [];
          }),
        );
      },
    ),
    removeRejectedToken: Effect.fn("DirectApnsDevices.removeRejectedToken")(function* (input) {
      yield* devices.modify((items) =>
        items.filter(
          (device) => !(device.deviceId === input.deviceId && device.apnsToken === input.apnsToken),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DirectApnsDevices, make);
