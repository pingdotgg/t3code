import type {
  RelayAgentActivityAggregateState,
  RelayDeliveryResult,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as Devices from "./Devices.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import * as LiveActivities from "./LiveActivities.ts";
import {
  isAndroidMobileTarget,
  type AndroidMobileTarget,
  type MobileTarget,
} from "./mobileTargets.ts";

export type { AndroidMobileTarget, IosMobileTarget, MobileTarget } from "./mobileTargets.ts";
export { isAndroidMobileTarget };

export type MobileDeliveryError =
  | ApnsDeliveries.ApnsDeliveryError
  | FcmDeliveries.FcmDeliveryError
  | Devices.DeviceListPersistenceError;

export class MobileDeliveries extends Context.Service<
  MobileDeliveries,
  {
    readonly listTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<MobileTarget>, MobileDeliveryError>;
    readonly sendForTarget: (input: {
      readonly target: MobileTarget;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly nowMs: number;
    }) => Effect.Effect<RelayDeliveryResult | null, MobileDeliveryError>;
    readonly sendPushNotificationForTarget: (input: {
      readonly target: MobileTarget;
      readonly aggregate: RelayAgentActivityAggregateState | null;
    }) => Effect.Effect<RelayDeliveryResult | null, MobileDeliveryError>;
  }
>()("t3code-relay/agentActivity/MobileDeliveries") {}

export const make = Effect.gen(function* () {
  const liveActivities = yield* LiveActivities.LiveActivities;
  const devices = yield* Devices.Devices;
  const apnsDeliveries = yield* ApnsDeliveries.ApnsDeliveries;
  const fcmDeliveries = yield* FcmDeliveries.FcmDeliveries;

  return MobileDeliveries.of({
    listTargets: Effect.fn("relay.mobile_deliveries.list_targets")(function* (input) {
      const [iosTargets, androidTargets] = yield* Effect.all(
        [
          liveActivities.listTargets({ userId: input.userId }),
          devices.listAndroidPushTargets({ userId: input.userId }),
        ],
        { concurrency: 2 },
      );
      return [...iosTargets, ...androidTargets];
    }),
    sendForTarget: Effect.fnUntraced(function* (input) {
      if (isAndroidMobileTarget(input.target)) {
        return yield* fcmDeliveries.sendForTarget({
          target: input.target,
          aggregate: input.aggregate,
        });
      }
      return yield* apnsDeliveries.sendForTarget({
        target: input.target,
        aggregate: input.aggregate,
        nowMs: input.nowMs,
      });
    }),
    sendPushNotificationForTarget: Effect.fnUntraced(function* (input) {
      if (isAndroidMobileTarget(input.target)) {
        return yield* fcmDeliveries.sendPushNotificationForTarget({
          target: input.target,
          aggregate: input.aggregate,
        });
      }
      return yield* apnsDeliveries.sendPushNotificationForTarget({
        target: input.target,
        aggregate: input.aggregate,
      });
    }),
  });
});

export const layer = Layer.effect(MobileDeliveries, make);
