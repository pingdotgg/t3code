import type { PreviewViewportSetting } from "@t3tools/contracts";

export function reconcileLockedAspectRatio(
  current: number | null,
  viewportAspectRatio: number | null,
): number | null {
  return current === null || viewportAspectRatio === null ? null : viewportAspectRatio;
}

export async function commitViewportAndAspectRatio(
  setting: PreviewViewportSetting,
  aspectRatio: number | null,
  onChange: (setting: PreviewViewportSetting) => Promise<void>,
  onAspectRatioChange: (aspectRatio: number | null) => void,
): Promise<void> {
  await onChange(setting);
  onAspectRatioChange(aspectRatio);
}
