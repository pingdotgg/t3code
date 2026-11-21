import { defineNativeBuiltinPlugin } from "./define";

export const nativeThreadPlugin = defineNativeBuiltinPlugin("t3.thread", [
  "native.features.threads.thread-route-screen.thread-route-content",
  "native.features.threads.thread-detail-screen",
  "native.features.threads.thread-route-screen.thread-header",
  "native.features.threads.thread-composer",
  "native.features.threads.thread-feed",
  "chat.work-log",
  "native.features.threads.thread-agents-sheet",
  "native.features.threads.thread-queue-control.thread-queue-sheet",
  "native.features.threads.pending-approval-card",
  "native.features.threads.pending-user-input-card",
  "native.features.threads.new-task-route-screen",
  "native.features.threads.new-task-draft-route-screen",
]);
