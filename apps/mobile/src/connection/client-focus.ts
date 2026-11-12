import { MOBILE_APP_NAME } from "../lib/mobileBranding";
import {
  makeClientFocusDispatcher,
  makeClientFocusLayer,
} from "@t3tools/client-runtime/client-focus";
import * as Effect from "effect/Effect";
import * as Device from "expo-device";
import { Platform } from "react-native";

import { mobileClientId } from "./background-activity";

const dispatcher = makeClientFocusDispatcher();

/** Registered by the root navigator, which applies each request. */
export const setMobileClientFocusHandler = dispatcher.setHandler;

export const mobileClientFocusLayer = makeClientFocusLayer({
  host: Effect.map(mobileClientId, (clientId) => ({
    clientId,
    clientKind: "mobile" as const,
    label: Device.deviceName?.trim() || Device.modelName?.trim() || `${MOBILE_APP_NAME} Mobile`,
    ...(Platform.OS === "ios" ? { platform: "iOS" } : { platform: "Android" }),
  })),
  onRequest: dispatcher.onRequest,
});
