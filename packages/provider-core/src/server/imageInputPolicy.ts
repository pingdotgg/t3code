import type { ChatAttachment } from "@t3tools/contracts";
import { isProviderNativeImageAttachment } from "./attachmentPrompt.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function imageSupportFromInput(value: unknown): boolean | undefined {
  const image = field(value, "image");
  if (typeof image === "boolean") return image;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.some((item: string) => item === "image" || item.startsWith("image/"));
  }
  return undefined;
}

/**
 * Read native image input support from provider model metadata.
 *
 * OpenCode exposes `capabilities.input.image`, while Pi reports an `input`
 * modality list. Missing or unrecognized metadata is intentionally unknown,
 * not false, so other providers retain their previous attachment behavior.
 */
export function modelImageInputSupport(model: unknown): boolean | undefined {
  return (
    imageSupportFromInput(field(field(model, "capabilities"), "input")) ??
    imageSupportFromInput(field(field(field(model, "capabilities"), "modalities"), "input")) ??
    imageSupportFromInput(field(model, "input")) ??
    imageSupportFromInput(field(field(model, "modalities"), "input"))
  );
}

/** Keep text/file-path context even when the selected model has no vision input. */
export function shouldSendNativeImage(input: {
  readonly attachment: ChatAttachment;
  readonly supportsImageInput: boolean | undefined;
}): boolean {
  return (
    input.supportsImageInput !== false &&
    isProviderNativeImageAttachment(input.attachment)
  );
}
