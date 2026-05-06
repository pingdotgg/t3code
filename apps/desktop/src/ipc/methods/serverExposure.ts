import {
  AdvertisedEndpoint,
  DesktopServerExposureModeSchema,
  DesktopServerExposureStateSchema,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DesktopShutdown } from "../../desktopShutdown.ts";
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

export interface DesktopServerExposureIpcActionsShape {
  readonly getState: Effect.Effect<DesktopServerExposureState>;
  readonly setMode: (
    mode: DesktopServerExposureMode,
  ) => Effect.Effect<DesktopServerExposureState, unknown, DesktopShutdown>;
  readonly setTailscaleServeEnabled: (
    input: typeof SetTailscaleServeEnabledInput.Type,
  ) => Effect.Effect<DesktopServerExposureState, unknown, DesktopShutdown>;
  readonly getAdvertisedEndpoints: Effect.Effect<readonly (typeof AdvertisedEndpoint.Type)[]>;
}

export class DesktopServerExposureIpcActions extends Context.Service<
  DesktopServerExposureIpcActions,
  DesktopServerExposureIpcActionsShape
>()("t3/desktop/Ipc/ServerExposure") {}

export const getServerExposureState = makeIpcMethod({
  channel: GET_SERVER_EXPOSURE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopServerExposureStateSchema,
  handler: () =>
    Effect.gen(function* () {
      const serverExposure = yield* DesktopServerExposureIpcActions;
      return yield* serverExposure.getState;
    }),
});

export const setServerExposureMode = makeIpcMethod({
  channel: SET_SERVER_EXPOSURE_MODE_CHANNEL,
  payload: DesktopServerExposureModeSchema,
  result: DesktopServerExposureStateSchema,
  handler: (mode) =>
    Effect.gen(function* () {
      const serverExposure = yield* DesktopServerExposureIpcActions;
      return yield* serverExposure.setMode(mode);
    }),
});

export const setTailscaleServeEnabled = makeIpcMethod({
  channel: SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  payload: SetTailscaleServeEnabledInput,
  result: DesktopServerExposureStateSchema,
  handler: (input) =>
    Effect.gen(function* () {
      const serverExposure = yield* DesktopServerExposureIpcActions;
      return yield* serverExposure.setTailscaleServeEnabled(input);
    }),
});

export const getAdvertisedEndpoints = makeIpcMethod({
  channel: GET_ADVERTISED_ENDPOINTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(AdvertisedEndpoint),
  handler: () =>
    Effect.gen(function* () {
      const serverExposure = yield* DesktopServerExposureIpcActions;
      return yield* serverExposure.getAdvertisedEndpoints;
    }),
});
