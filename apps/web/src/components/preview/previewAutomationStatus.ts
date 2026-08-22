import type { PreviewAutomationStatus, PreviewNavStatus } from "@t3tools/contracts";

/**
 * preview_status must not report a failed guest as a healthy automation target.
 * Keep the requested URL so Retry/navigate still have something useful; the
 * chrome-error interstitial is not a navigable address.
 *
 * When a live desktop status already says the guest is available, keep it.
 * A stale LoadFailed snapshot can lag a successful retry.
 */
export function applyPreviewLoadFailureToAutomationStatus(
  status: PreviewAutomationStatus,
  navStatus: PreviewNavStatus | undefined,
  options?: { readonly preferLiveAvailability?: boolean },
): PreviewAutomationStatus {
  if (navStatus?._tag !== "LoadFailed") return status;
  if (options?.preferLiveAvailability && status.available) return status;
  return {
    ...status,
    available: false,
    loading: false,
    url: navStatus.url,
    title: navStatus.description || status.title,
  };
}
