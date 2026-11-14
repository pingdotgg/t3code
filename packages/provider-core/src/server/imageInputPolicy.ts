import type { ChatAttachment } from "@t3tools/contracts";
import { isProviderNativeImageAttachment } from "./attachmentPrompt.ts";

/**
 * Determine whether an attachment may be forwarded as a native image.
 *
 * Unknown capability intentionally preserves existing provider behavior until
 * a trustworthy capability value is available. Providers must not infer vision
 * support from the MIME type alone.
 */
export function shouldSendNativeImage(input: {
  readonly attachment: ChatAttachment;
  readonly supportsImageInput: boolean | undefined;
}): boolean {
  return (
    input.supportsImageInput !== false &&
    isProviderNativeImageAttachment(input.attachment)
  );
}
