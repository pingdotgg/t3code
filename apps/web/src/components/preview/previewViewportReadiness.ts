import type { PreviewRenderedViewportSize, PreviewViewportSetting } from "@t3tools/contracts";

import { browserViewportSettingKey } from "~/browser/browserViewportLayout";

export function isPreviewViewportReady(input: {
  readonly setting: PreviewViewportSetting;
  readonly appliedSettingKey: string | null;
  readonly declaredViewport: PreviewRenderedViewportSize | null;
  readonly renderedViewport: PreviewRenderedViewportSize | null;
}): boolean {
  const { setting, appliedSettingKey, declaredViewport, renderedViewport } = input;
  if (
    appliedSettingKey !== browserViewportSettingKey(setting) ||
    declaredViewport === null ||
    renderedViewport === null
  ) {
    return false;
  }

  const expectedViewport =
    setting._tag === "fill" ? declaredViewport : { width: setting.width, height: setting.height };
  if (
    setting._tag !== "fill" &&
    (declaredViewport.width !== expectedViewport.width ||
      declaredViewport.height !== expectedViewport.height)
  ) {
    return false;
  }

  // Electron rounds CSS pixels through the guest's fractional zoom/device scale,
  // so a successfully applied fixed viewport can measure one pixel either way.
  const tolerance = 1;
  return (
    Math.abs(renderedViewport.width - expectedViewport.width) <= tolerance &&
    Math.abs(renderedViewport.height - expectedViewport.height) <= tolerance
  );
}

export async function waitForPreviewViewportReadiness(input: {
  readonly setting: PreviewViewportSetting;
  readonly timeoutMs: number;
  readonly assertCurrent: () => void;
  readonly readViewport: () => Promise<{
    readonly appliedSettingKey: string | null;
    readonly declaredViewport: PreviewRenderedViewportSize | null;
    readonly renderedViewport: PreviewRenderedViewportSize | null;
  } | null>;
}): Promise<PreviewRenderedViewportSize | null> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    input.assertCurrent();
    let viewportState: Awaited<ReturnType<typeof input.readViewport>> = null;
    try {
      viewportState = await input.readViewport();
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }
    input.assertCurrent();
    if (viewportState && isPreviewViewportReady({ setting: input.setting, ...viewportState })) {
      return viewportState.renderedViewport;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(50, remainingMs)));
  }
  return null;
}
