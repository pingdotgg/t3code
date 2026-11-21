import { defineNativeBuiltinPlugin } from "./define";

export const nativeFilePreviewPlugin = defineNativeBuiltinPlugin("t3.file-preview", [
  "file-preview",
  "file-tree",
  "attachment-preview",
  "native.features.files.file-tree-browser",
  "native.features.files.thread-file-navigator-pane",
  "native.features.files.source-file-surface",
]);
