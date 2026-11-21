import { defineNativeBuiltinPlugin } from "./define";

export const nativePullRequestsPlugin = defineNativeBuiltinPlugin("t3.pull-requests", [
  "native.features.pull-requests.pull-requests-screen",
  "native.features.pull-requests.pull-request-route-screen",
  "native.features.pull-requests.pull-request-files-route-screen",
  "native.features.pull-requests.pull-request-file-route-screen",
  "native.features.pull-requests.pull-request-review-sheet",
]);
