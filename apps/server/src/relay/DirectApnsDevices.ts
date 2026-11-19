import { PushDeviceRegistration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export type StoredPushDevice = PushDeviceRegistration;

// APNs device tokens are bearer-like identifiers for pushing to a phone, so
// they live in the secret store (mode-600 files in a mode-700 directory)
// rather than in settings.json or the database.
const DEVICES_SECRET = "direct-apns-devices";

const DevicesJson = Schema.fromJsonString(Schema.Array(PushDeviceRegistration));
const decodeDevices = Schema.decodeUnknownEffect(DevicesJson);
const encodeDevices = Schema.encodeEffect(DevicesJson);

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

  const read = secrets.get(DEVICES_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<StoredPushDevice>>([]),
        onSome: (bytes) =>
          decodeDevices(new TextDecoder().decode(bytes)).pipe(
            // A corrupt file must not block registering a fresh token.
            Effect.catch(() => Effect.succeed<ReadonlyArray<StoredPushDevice>>([])),
          ),
      }),
    ),
  );

  const modify = (
    change: (devices: ReadonlyArray<StoredPushDevice>) => ReadonlyArray<StoredPushDevice>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* read;
        const next = change(current);
        if (next.length === current.length && next.every((device, i) => device === current[i])) {
          return;
        }
        const encoded = yield* encodeDevices(next).pipe(Effect.orDie);
        yield* secrets.set(DEVICES_SECRET, new TextEncoder().encode(encoded));
      }),
    );

  return DirectApnsDevices.of({
    register: Effect.fn("DirectApnsDevices.register")(function* (device) {
      yield* modify((devices) => [
        ...devices.filter((existing) => existing.deviceId !== device.deviceId),
        device,
      ]);
    }),
    unregister: Effect.fn("DirectApnsDevices.unregister")(function* (deviceId) {
      yield* modify((devices) => devices.filter((device) => device.deviceId !== deviceId));
    }),
    list: lock.withPermits(1)(read),
    removeRejectedToken: Effect.fn("DirectApnsDevices.removeRejectedToken")(function* (input) {
      yield* modify((devices) =>
        devices.filter(
          (device) => !(device.deviceId === input.deviceId && device.apnsToken === input.apnsToken),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DirectApnsDevices, make);
