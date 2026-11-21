import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { builtinServiceLayer } from "@t3tools/shared/pluginKernel";
import { builtinPublishSubscriptionUsage } from "./builtinPublishSubscriptionUsage";
import {
  builtinGetAgentLiveActivities,
  builtinStartAgentLiveActivity,
} from "../features/agent-awareness/builtinAgentLiveActivity";

const builtin = {
  publishSubscriptionUsage: builtinPublishSubscriptionUsage,
  getAgentLiveActivities: builtinGetAgentLiveActivities,
  startAgentLiveActivity: builtinStartAgentLiveActivity,
};
let active = builtin;

export class NativeWidgetServices extends Context.Service<NativeWidgetServices, typeof builtin>()(
  "@t3tools/mobile/widgets/NativeWidgetServices",
) {}

/** Serialized widget layouts stay in Expo's extension; publication uses the host service facade. */
export function getNativeWidgetServices() {
  return active;
}

export const layer = builtinServiceLayer(
  "t3.mobile.widgets",
  NativeWidgetServices,
  Effect.succeed(builtin),
).pipe(
  Layer.tap((context) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const service = Context.get(context, NativeWidgetServices);
        active = service;
        return service;
      }),
      (service) =>
        Effect.sync(() => {
          if (active === service) active = builtin;
        }),
    ),
  ),
);
