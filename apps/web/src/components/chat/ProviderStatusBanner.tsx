import { ACP_REGISTRY_DRIVER_PREFIX, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isAcpRegistry = status.driver.startsWith(ACP_REGISTRY_DRIVER_PREFIX);
  const isUnauthenticated = status.auth.status === "unauthenticated";

  if (isAcpRegistry && isUnauthenticated) {
    return (
      <div className="pt-3 mx-auto max-w-3xl">
        <Alert variant="warning">
          <CircleAlertIcon />
          <AlertTitle>{providerLabel} requires authentication</AlertTitle>
          <AlertDescription>
            This provider requires authentication before it can be used. Go to{" "}
            <strong>Settings → Providers</strong> and click the "Authenticate" button for this
            provider.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});
