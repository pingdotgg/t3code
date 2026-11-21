import { defineNativeBuiltinPlugin } from "./define";

export const nativeUsagePlugin = defineNativeBuiltinPlugin("t3.usage", [
  "usage",
  "native.features.usage.chat-gpt-usage-summary",
  "native.features.usage.usage-daily-chart",
  "native.features.usage.usage-limits-pooled.usage-limits-section",
  "native.features.usage.usage-limits-pooled.usage-limit-account-screen",
]);
