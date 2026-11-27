import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PresentationIcon } from "lucide-react";

import { useVisualReply } from "../../lib/visualReply";
import { useServerConfigs } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/** Asks for the next messages to be answered visually, with OpenUI. */
export function ComposerVisualReplyToggle(props: {
  environmentId: EnvironmentId;
  size: ComposerControlSize;
  hidden: boolean;
}) {
  const gt = useGT();
  const [enabled, setEnabled] = useVisualReply();
  const supported =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.visualReplies === true;
  if (!supported || props.hidden) return null;
  const description = enabled
    ? gt("Visual answers are on. Click to get text answers.")
    : gt("Answer visually with OpenUI");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={props.size}
            className="shrink-0"
            data-composer-fixed-control
            aria-pressed={enabled}
            aria-label={gt("Visual answers with OpenUI")}
            onClick={() => setEnabled(!enabled)}
          />
        }
      >
        {/* The pressed background alone is too faint to read on the icon-only phone layout. */}
        <ComposerControlIcon
          icon={PresentationIcon}
          size={props.size}
          className={enabled ? "text-primary" : undefined}
        />
        {/* A product name, not translated. */}
        <span className="max-sm:sr-only">OpenUI</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
