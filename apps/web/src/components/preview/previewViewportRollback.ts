import type { PreviewViewportSetting } from "@t3tools/contracts";

import { browserViewportSettingKey } from "~/browser/browserViewportLayout";

const mutationsByRuntimeTabId = new Map<string, number>();
let nextMutation = 0;

export function beginPreviewViewportMutation(runtimeTabId: string): number {
  const mutation = ++nextMutation;
  mutationsByRuntimeTabId.set(runtimeTabId, mutation);
  return mutation;
}

export function finishPreviewViewportMutation(runtimeTabId: string, mutation: number): void {
  if (mutationsByRuntimeTabId.get(runtimeTabId) === mutation) {
    mutationsByRuntimeTabId.delete(runtimeTabId);
  }
}

export function shouldRollbackPreviewViewport(
  runtimeTabId: string,
  mutation: number,
  previous: PreviewViewportSetting,
  requested: PreviewViewportSetting,
  latest: PreviewViewportSetting,
  operationServerEpoch: string | null,
  currentServerEpoch: string | null,
): boolean {
  const requestedKey = browserViewportSettingKey(requested);
  return (
    mutationsByRuntimeTabId.get(runtimeTabId) === mutation &&
    currentServerEpoch === operationServerEpoch &&
    browserViewportSettingKey(latest) === requestedKey &&
    browserViewportSettingKey(previous) !== requestedKey
  );
}
