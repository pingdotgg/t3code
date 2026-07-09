import { memo } from "react";
import { extractProviderErrorMessage } from "@t3tools/shared/providerError";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  // errors persisted before the server started unwrapping provider payloads
  // can still be raw JSON, so unwrap here too
  const message = extractProviderErrorMessage(error);
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <Tooltip>
          <TooltipTrigger render={<AlertDescription className="line-clamp-3 break-words" />}>
            {message}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap break-words">
            {message}
          </TooltipPopup>
        </Tooltip>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
