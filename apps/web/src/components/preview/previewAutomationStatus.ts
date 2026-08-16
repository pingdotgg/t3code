import type { PreviewAutomationStatus, PreviewNavStatus } from "@t3tools/contracts";

/**
 * preview_status must not report a failed guest as a healthy automation target.
 * Keep the requested URL so Retry/navigate still have something useful; the
 * chrome-error interstitial is not a navigable address.
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
    url: navStatus.url,
    title: navStatus.description || status.title,
  };
}
