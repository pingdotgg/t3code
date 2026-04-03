function normalizePendingRequestDetail(detail: string | undefined): string {
  return detail?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

export function isUnknownPendingApprovalRequestDetail(detail: string | undefined): boolean {
  const normalized = normalizePendingRequestDetail(detail);
  return (
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request")
  );
}

export function isUnknownPendingUserInputRequestDetail(detail: string | undefined): boolean {
  const normalized = normalizePendingRequestDetail(detail);
  return (
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request")
  );
}

export function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = normalizePendingRequestDetail(detail);
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("stale pending user input request") ||
    isUnknownPendingApprovalRequestDetail(normalized) ||
    isUnknownPendingUserInputRequestDetail(normalized)
  );
}
