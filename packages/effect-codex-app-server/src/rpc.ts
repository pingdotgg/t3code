import * as Generated from "./_generated/meta.gen.ts";
import * as Realtime from "./realtime.ts";

export * from "./_generated/meta.gen.ts";

export const CLIENT_REQUEST_METHODS = {
  ...Generated.CLIENT_REQUEST_METHODS,
  "thread/realtime/start": "thread/realtime/start",
  "thread/realtime/stop": "thread/realtime/stop",
} as const;

export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;

export interface ClientRequestParamsByMethod extends Generated.ClientRequestParamsByMethod {
  readonly "thread/realtime/start": Realtime.ExperimentalRealtimeWebrtcStartParams;
  readonly "thread/realtime/stop": Realtime.ExperimentalRealtimeStopParams;
}

export interface ClientRequestResponsesByMethod extends Generated.ClientRequestResponsesByMethod {
  readonly "thread/realtime/start": Realtime.ExperimentalRealtimeResponse;
  readonly "thread/realtime/stop": Realtime.ExperimentalRealtimeResponse;
}

export const CLIENT_REQUEST_PARAMS = {
  ...Generated.CLIENT_REQUEST_PARAMS,
  "thread/realtime/start": Realtime.ExperimentalRealtimeWebrtcStartParams,
  "thread/realtime/stop": Realtime.ExperimentalRealtimeStopParams,
} as const;

export const CLIENT_REQUEST_RESPONSES = {
  ...Generated.CLIENT_REQUEST_RESPONSES,
  "thread/realtime/start": Realtime.ExperimentalRealtimeResponse,
  "thread/realtime/stop": Realtime.ExperimentalRealtimeResponse,
} as const;
