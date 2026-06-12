import type { EnvironmentApi, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import type { PreviewStateStoreState } from "~/previewStateStore";

interface OpenPreviewSessionInput {
  previewApi: Pick<EnvironmentApi["preview"], "open">;
  threadRef: ScopedThreadRef;
  url: string;
  applyServerSnapshot: PreviewStateStoreState["applyServerSnapshot"];
  rememberUrl: PreviewStateStoreState["rememberUrl"];
}

export async function openPreviewSession(
  input: OpenPreviewSessionInput,
): Promise<PreviewSessionSnapshot> {
  const snapshot = await input.previewApi.open({
    threadId: input.threadRef.threadId,
    url: input.url,
  });
  input.applyServerSnapshot(input.threadRef, snapshot);
  input.rememberUrl(
    input.threadRef,
    snapshot.navStatus._tag === "Idle" ? input.url : snapshot.navStatus.url,
  );
  return snapshot;
}
