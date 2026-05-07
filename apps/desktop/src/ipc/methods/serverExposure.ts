import {
  AdvertisedEndpoint,
  DesktopServerExposureModeSchema,
  DesktopServerExposureStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../main/DesktopLifecycle.ts";
import * as DesktopServerExposure from "../../main/DesktopServerExposure.ts";
import {
  GET_ADVERTISED_ENDPOINTS_CHANNEL,
  GET_SERVER_EXPOSURE_STATE_CHANNEL,
  SET_SERVER_EXPOSURE_MODE_CHANNEL,
  SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
} from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const SetTailscaleServeEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optionalKey(Schema.Number),
});

export const getServerExposureState = makeIpcMethod({
  channel: GET_SERVER_EXPOSURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopServerExposureStateSchema,
  handler: () =>
    Effect.gen(function* () {
      const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
      return yield* serverExposure.getState;
    }),
});

export const setServerExposureMode = makeIpcMethod({
  channel: SET_SERVER_EXPOSURE_MODE_CHANNEL,
  payload: DesktopServerExposureModeSchema,
  result: DesktopServerExposureStateSchema,
  handler: (mode) =>
    Effect.gen(function* () {
      const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
      const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
      const change = yield* serverExposure.setMode(mode);
      if (change.requiresRelaunch) {
        yield* lifecycle.relaunch(`serverExposureMode=${mode}`);
      }
      return change.state;
    }),
});

export const setTailscaleServeEnabled = makeIpcMethod({
  channel: SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  payload: SetTailscaleServeEnabledInput,
  result: DesktopServerExposureStateSchema,
  handler: (input) =>
    Effect.gen(function* () {
      const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
      const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
      const change = yield* serverExposure.setTailscaleServeEnabled(input);
      if (change.requiresRelaunch) {
        yield* lifecycle.relaunch(
          change.state.tailscaleServeEnabled
            ? "tailscale-serve-enabled"
            : "tailscale-serve-disabled",
        );
      }
      return change.state;
    }),
});

export const getAdvertisedEndpoints = makeIpcMethod({
  channel: GET_ADVERTISED_ENDPOINTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(AdvertisedEndpoint),
  handler: () =>
    Effect.gen(function* () {
      const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
      return yield* serverExposure.getAdvertisedEndpoints;
    }),
});
