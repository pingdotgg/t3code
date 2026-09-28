import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "~/browser/browserDefaults";
import { applyPreviewServerSnapshot, rememberPreviewUrl } from "~/previewStateStore";

export interface OpenPreviewMutation<E> {
  (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewOpenInput;
  }): Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;
}

interface OpenPreviewSessionInput<E> {
  openPreview: OpenPreviewMutation<E>;
  threadRef: ScopedThreadRef;
  url?: string;
  viewport?: PreviewViewportSetting;
  profileId?: string;
  beforeOpen?: (profileId: string) => Promise<void>;
}

export async function openPreviewSession<E>(
  input: OpenPreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewSessionSnapshot, E>> {
  const defaults = await resolveBrowserDefaults();
  const profileId = input.profileId ?? browserDefaultOpenProfileId(defaults);
  await input.beforeOpen?.(profileId);
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      ...(input.url === undefined ? {} : { url: input.url }),
      viewport: input.viewport ?? browserDefaultOpenViewport(defaults),
      profileId,
    },
  });
  if (result._tag === "Failure") {
    return result;
  }
  const snapshot = result.value;
  applyPreviewServerSnapshot(input.threadRef, snapshot);
  if (input.url !== undefined) {
    rememberPreviewUrl(
      input.threadRef,
      snapshot.navStatus._tag === "Idle" ? input.url : snapshot.navStatus.url,
    );
  }
  return result;
}
