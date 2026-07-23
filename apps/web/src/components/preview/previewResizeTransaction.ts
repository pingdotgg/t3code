import type { PreviewRenderedViewportSize, PreviewViewportSetting } from "@t3tools/contracts";

const MAX_ROLLBACK_WAIT_MS = 2_000;

export async function resizePreviewViewportTransaction<Snapshot>(input: {
  readonly setting: PreviewViewportSetting;
  readonly previousSetting: PreviewViewportSetting;
  readonly timeoutMs: number;
  readonly applySetting: (setting: PreviewViewportSetting) => Promise<Snapshot>;
  readonly updateSnapshot: (snapshot: Snapshot) => void;
  readonly waitForViewport: (
    setting: PreviewViewportSetting,
    timeoutMs: number,
  ) => Promise<PreviewRenderedViewportSize>;
}): Promise<PreviewRenderedViewportSize> {
  const snapshot = await input.applySetting(input.setting);
  input.updateSnapshot(snapshot);

  try {
    return await input.waitForViewport(input.setting, input.timeoutMs);
  } catch (error) {
    try {
      const previousSnapshot = await input.applySetting(input.previousSetting);
      input.updateSnapshot(previousSnapshot);
      await input.waitForViewport(
        input.previousSetting,
        Math.min(input.timeoutMs, MAX_ROLLBACK_WAIT_MS),
      );
    } catch {
      // Preserve the original resize failure even when best-effort rollback cannot render.
    }
    throw error;
  }
}
