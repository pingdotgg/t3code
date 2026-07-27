import type { PreviewViewportSetting } from "@t3tools/contracts";

import { browserViewportSettingKey } from "~/browser/browserViewportLayout";

export function shouldRollbackPreviewViewport(
  previous: PreviewViewportSetting,
  requested: PreviewViewportSetting,
  latest: PreviewViewportSetting,
  operationServerEpoch: string | null,
  currentServerEpoch: string | null,
): boolean {
  const requestedKey = browserViewportSettingKey(requested);
  return (
    currentServerEpoch === operationServerEpoch &&
    browserViewportSettingKey(latest) === requestedKey &&
    browserViewportSettingKey(previous) !== requestedKey
  );
}
