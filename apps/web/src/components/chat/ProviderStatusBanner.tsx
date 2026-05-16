import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
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
        <Tooltip>
          <TooltipTrigger render={<AlertDescription className="line-clamp-3" />}>
            {status.message ?? defaultMessage}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
            {status.message ?? defaultMessage}
          </TooltipPopup>
        </Tooltip>
      </Alert>
    </div>
  );
});
