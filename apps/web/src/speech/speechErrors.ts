import { EnvironmentRequestInvalidError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isRequestInvalid = Schema.is(EnvironmentRequestInvalidError);

/** What went wrong with OpenRouter, in words a user can act on; null for other failures. */
export function speechCloudFailureMessage(
  error: unknown,
  where: "composer" | "settings" = "composer",
): string | null {
  if (!isRequestInvalid(error)) return null;
  switch (error.reason) {
    case "speech_cloud_key_invalid":
      return where === "settings"
        ? "OpenRouter didn't accept this API key."
        : "OpenRouter didn't accept the API key. Check it in Settings → Voice.";
    case "speech_cloud_credits":
      return "Your OpenRouter account is out of credits.";
    case "speech_cloud_failed":
      return "OpenRouter couldn't transcribe this recording. Try again or choose another model.";
    default:
      return null;
  }
}
