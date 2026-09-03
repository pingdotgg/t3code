import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type DesktopPreviewBridge,
  type DesktopPreviewWebviewConfig,
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
  { environmentId: Schema.String, projectId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}" project "${this.projectId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedErrorClass<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    projectId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}" project "${this.projectId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

class PreviewWebviewConfigKeyParseError extends Schema.TaggedErrorClass<PreviewWebviewConfigKeyParseError>()(
  "PreviewWebviewConfigKeyParseError",
  { key: Schema.String },
) {
  override get message(): string {
    return `Invalid preview webview config key: ${this.key}`;
  }
}

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  projectId: ProjectId,
  profileId: string | undefined,
  bridge: PreviewConfigBridge | null = previewBridge,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId, projectId }));
  }

  return Effect.tryPromise({
    try: () =>
      bridge.getPreviewConfig({
        environmentId,
        projectId,
        ...(profileId === undefined ? {} : { profileId }),
      }),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, projectId, cause }),
  });
};

/**
 * Atom.family keys on one string, so encode the full identity in a stable
 * tuple. JSON framing keeps ids containing the delimiter or a colon distinct.
 */
const configKey = (
  environmentId: EnvironmentId,
  projectId: ProjectId,
  profileId: string | undefined,
): string => JSON.stringify([environmentId, projectId, profileId ?? null]);

interface PreviewWebviewConfigKey {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly profileId: string | undefined;
}

const parseConfigKey = (key: string): PreviewWebviewConfigKey => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new PreviewWebviewConfigKeyParseError({ key });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    (parsed[2] !== null && typeof parsed[2] !== "string")
  ) {
    throw new PreviewWebviewConfigKeyParseError({ key });
  }
  return {
    environmentId: EnvironmentId.make(parsed[0]),
    projectId: ProjectId.make(parsed[1]),
    profileId: parsed[2] === null ? undefined : parsed[2],
  };
};

const idlePreviewWebviewConfigAtom = Atom.make(
  AsyncResult.initial<DesktopPreviewWebviewConfig, PreviewWebviewConfigError>(false),
).pipe(Atom.withLabel("preview:webview-config:idle"));

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, projectId, profileId } = parseConfigKey(key);
  return Atom.make(loadPreviewWebviewConfig(environmentId, projectId, profileId)).pipe(
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
  projectId: ProjectId | null,
  profileId: string | undefined,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(
    projectId === null
      ? idlePreviewWebviewConfigAtom
      : previewWebviewConfigAtom(configKey(environmentId, projectId, profileId)),
  );
  return Option.getOrNull(AsyncResult.value(result));
}
