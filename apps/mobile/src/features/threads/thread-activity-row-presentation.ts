import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

export function resolveThreadActivityMetadata(input: {
  readonly providerDriver: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
}): string {
  const providerLabel = input.providerDriver
    ? (PROVIDER_DISPLAY_NAMES[input.providerDriver] ?? input.providerInstanceId)
    : input.providerInstanceId;
  const values = [providerLabel, input.model].filter(
    (value): value is string => value !== null && value.length > 0,
  );
  return [...new Set(values)].join(" · ");
}

export function resolveThreadActivityStatus(status: OrchestrationV2TurnItem["status"]): {
  readonly label: string;
  readonly tone: "active" | "danger" | "success" | "warning";
} {
  const label = status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
  switch (status) {
    case "completed":
      return { label, tone: "success" };
    case "failed":
      return { label, tone: "danger" };
    case "cancelled":
    case "interrupted":
      return { label, tone: "warning" };
    case "pending":
    case "running":
    case "waiting":
      return { label, tone: "active" };
  }
}
