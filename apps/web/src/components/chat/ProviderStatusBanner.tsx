import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { formatProviderKindLabel } from "../../providerModels";
import { ErrorAlert } from "~/components/ui/error-alert";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderKindLabel(status.provider);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <ErrorAlert
        variant={status.status === "error" ? "error" : "warning"}
        title={`${providerLabel} provider status`}
        message={status.message ?? defaultMessage}
      />
    </div>
  );
});
