import { useAtomValue } from "@effect/atom-react";
import type { DesktopPreviewWebviewConfig, EnvironmentId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

class PreviewWebviewConfigError extends Data.TaggedError("PreviewWebviewConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const previewWebviewConfigAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    Effect.tryPromise({
      try: () => {
        if (!previewBridge) {
          throw new Error("Desktop preview bridge is unavailable.");
        }
        return previewBridge.getPreviewConfig(environmentId);
      },
      catch: (cause) =>
        new PreviewWebviewConfigError({
          message: "Could not load desktop preview configuration.",
          cause,
        }),
    }),
  ).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${environmentId}`),
  ),
);

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(previewWebviewConfigAtom(environmentId));
  return Option.getOrNull(AsyncResult.value(result));
}
