import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadConversationWidthContainer } from "./ThreadConversationWidth";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <ThreadConversationWidthContainer className="pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        <Tooltip>
          <TooltipTrigger render={<AlertDescription className="line-clamp-3" />}>
            {error}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
            {error}
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
    </ThreadConversationWidthContainer>
  );
});
