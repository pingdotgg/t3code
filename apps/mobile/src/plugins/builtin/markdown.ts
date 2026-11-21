import { defineNativeBuiltinPlugin } from "./define";

export const nativeMarkdownPlugin = defineNativeBuiltinPlugin("t3.markdown", [
  "markdown",
  "markdown.file",
  "markdown.pull-request",
  "native.features.threads.thread-feed.assistant-markdown-content",
  "native.features.threads.thread-feed.user-message-markdown-content",
  "native.features.threads.thread-markdown-image",
  "native.features.threads.thread-markdown-video",
]);
