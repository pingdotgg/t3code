import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadConversationWidthContainer } from "./ThreadConversationWidth";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? "Sign in via the CLI to authenticate again."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));

  return (
    <ThreadConversationWidthContainer className="pt-3">
      <div
        className={cn(
          "flex items-center gap-3 rounded-xl border px-3.5 py-3 text-card-foreground text-sm",
          status.status === "warning"
            ? "border-warning/32 bg-warning/4 [&_svg]:text-warning"
            : "border-destructive/32 bg-destructive/4 text-destructive-foreground [&_svg]:text-destructive",
        )}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </ThreadConversationWidthContainer>
  );
});
