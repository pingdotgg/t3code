import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewBridge,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedErrorClass<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedErrorClass<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  profileId?: string,
  bridge: PreviewConfigBridge | null = previewBridge,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, profileId),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

/**
 * `Atom.family` keys on its argument, so the environment and profile are
 * folded into one string: passing an object would allocate a fresh entry on
 * every render.
 */
const configKey = (environmentId: EnvironmentId, profileId: string | undefined): string =>
  `${environmentId}\u0000${profileId ?? ""}`;

const parseConfigKey = (key: string): { environmentId: EnvironmentId; profileId?: string } => {
  const [environmentId = "", profileId = ""] = key.split("\u0000");
  return {
    environmentId: environmentId as EnvironmentId,
    ...(profileId === "" ? {} : { profileId }),
  };
};

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, profileId } = parseConfigKey(key);
  return Atom.make(loadPreviewWebviewConfig(environmentId, profileId)).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  profileId?: string,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(previewWebviewConfigAtom(configKey(environmentId, profileId)));
  return Option.getOrNull(AsyncResult.value(result));
}
