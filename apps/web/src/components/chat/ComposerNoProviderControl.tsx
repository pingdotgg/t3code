import { Link } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

export function ComposerNoProviderControl() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <ComposerControl
          render={<Link to="/settings/providers" />}
          aria-label="Open provider settings"
          className="-ms-2.5"
          data-chat-provider-unavailable="true"
        >
          <ComposerControlIcon icon={CircleAlertIcon} />
          No provider available
        </ComposerControl>
      </TooltipTrigger>
      <TooltipPopup>Open provider settings</TooltipPopup>
    </Tooltip>
  );
}
