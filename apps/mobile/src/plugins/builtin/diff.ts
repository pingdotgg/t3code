import { defineNativeBuiltinPlugin } from "./define";

export const nativeDiffPlugin = defineNativeBuiltinPlugin("t3.diff", [
  "diff",
  "native.features.review.review-comment-card",
  "native.features.review.review-comment-composer-sheet",
  "native.features.review.review-diff-rendering.review-change-bar",
  "native.features.review.review-diff-rendering.diff-token-text",
]);
