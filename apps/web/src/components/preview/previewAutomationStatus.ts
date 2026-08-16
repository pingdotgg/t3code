import type { PreviewAutomationStatus, PreviewNavStatus } from "@t3tools/contracts";

/** Chromium interstitials such as chrome-error://chromewebdata/. */
export function isChromeErrorPreviewUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("chrome-error:");
}

/**
 * preview_status must not report a failed guest as a healthy automation target.
 * Prefer the chrome-error URL when the guest landed on one; otherwise keep the
 * requested URL so Retry/navigate still have something useful.
 */
export function applyPreviewLoadFailureToAutomationStatus(
  status: PreviewAutomationStatus,
  navStatus: PreviewNavStatus | undefined,
): PreviewAutomationStatus {
  if (navStatus?._tag !== "LoadFailed") return status;
  return {
    ...status,
    available: false,
    loading: false,
    url: isChromeErrorPreviewUrl(status.url) ? status.url : navStatus.url,
    title: navStatus.description || status.title,
  };
}
