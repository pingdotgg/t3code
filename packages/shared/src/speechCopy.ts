import { CLOUD_SPEECH_PROVIDER_NAMES, type CloudSpeechProvider } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** @public */
export function cloudSpeechDisclosure(
  provider: CloudSpeechProvider,
  environment: string,
  resolve: MFunctionType = mFallback,
) {
  return provider === "openrouter"
    ? resolve(
        msg(
          "After you stop, {environment} sends the recording to OpenRouter. OpenRouter chooses who runs your model. T3 requests zero data retention; your OpenRouter account may allow safety retention.",
          { environment },
        ),
      )
    : resolve(
        msg(
          "After you stop, {environment} sends your recording and vocabulary hints, including project names, to {provider}.",
          { environment, provider: CLOUD_SPEECH_PROVIDER_NAMES[provider] },
        ),
      );
}
