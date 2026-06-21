import type {
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Devices from "./Devices.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";

export type MobileRegistrationError =
  | Devices.DeviceRegistrationPersistenceError
  | Devices.DeviceUnregistrationPersistenceError
  | LiveActivities.LiveActivityRegistrationPersistenceError;

export class MobileRegistrations extends Context.Service<
  MobileRegistrations,
  {
    readonly registerDevice: (input: {
      readonly userId: string;
      readonly payload: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<{ readonly ok: true }, MobileRegistrationError>;
    readonly registerLiveActivity: (input: {
      readonly userId: string;
      readonly payload: RelayLiveActivityRegistrationRequest;
    }) => Effect.Effect<{ readonly ok: true }, MobileRegistrationError>;
    readonly unregisterDevice: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<{ readonly ok: true }, MobileRegistrationError>;
  }
>()("t3code-relay/agentActivity/MobileRegistrations") {}

export const make = Effect.gen(function* () {
  const devices = yield* Devices.Devices;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;

  return MobileRegistrations.of({
    registerDevice: Effect.fn("relay.mobile_registrations.register_device")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.payload.deviceId,
        "relay.mobile.platform": input.payload.platform,
      });
      yield* devices.register({ userId: input.userId, registration: input.payload });
      yield* publisher
        .replayForLiveActivityRegistration({
          userId: input.userId,
          deviceId: input.payload.deviceId,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("device registration activity replay failed", {
              errorTag: error._tag,
            }),
          ),
          Effect.ignore,
        );
      return { ok: true as const };
    }),
    registerLiveActivity: Effect.fn("relay.mobile_registrations.register_live_activity")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.payload.deviceId,
        });
        yield* liveActivities.register({ userId: input.userId, registration: input.payload });
        yield* publisher
          .replayForLiveActivityRegistration({
            userId: input.userId,
            deviceId: input.payload.deviceId,
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("live activity registration replay failed", {
                errorTag: error._tag,
              }),
            ),
            Effect.ignore,
          );
        return { ok: true as const };
      },
    ),
    unregisterDevice: Effect.fn("relay.mobile_registrations.unregister_device")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.mobile.device_id": input.deviceId,
      });
      yield* devices.unregister(input);
      return { ok: true as const };
    }),
  });
});

export const layer = Layer.effect(MobileRegistrations, make);
