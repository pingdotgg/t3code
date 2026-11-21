import { defineNativeBuiltinPlugin } from "./define";

export const nativePreviewPlugin = defineNativeBuiltinPlugin("t3.preview", [
  "native.features.browser.browser-preview-route-screen",
  "native.features.browser.thread-browser-float",
  "device",
  "native.features.devices.device-stream-web-view",
  "native.features.devices.device-preview-button",
]);
