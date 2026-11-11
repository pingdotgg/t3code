import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadMessagePin,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { BotIcon, ChevronDownIcon, PinIcon, PinOffIcon, UserIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useThreadMessagePins } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSetMessagePin } from "./MessagePinButton";
import { revealThreadMessage } from "./messageReveal";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadMessagePinsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const pins = useThreadMessagePins(threadRef);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const setMessagePin = useSetMessagePin(threadRef);
  const [expanded, setExpanded] = useLocalStorage(
    "t3code:thread-details:message-pins-expanded",
    false,
    Schema.Boolean,
  );
  if (pins.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-message-pins-heading"
      title="Pinned messages"
      showHeading={false}
    >
      <div className="flex flex-col">
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="row"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <PinIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            Pinned messages
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{pins.length}</span>
          <ChevronDownIcon
            className={cn(THREAD_DETAILS_PANEL_CHEVRON_CLASS, expanded && "rotate-180")}
            aria-hidden
          />
        </ThreadDetailsControl>
        {expanded ? (
          <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0">
            {pins.map((pin) => (
              <li key={pin.messageId} className="flex items-center gap-1">
                <PinnedMessageRow
                  pin={pin}
                  onReveal={() => void revealThreadMessage(threadRef, pin.messageId)}
                />
                {canOperate ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          aria-label="Unpin message"
                          onClick={() => void setMessagePin(pin.messageId, false)}
                        >
                          <PinOffIcon className="size-3.5" />
                        </ThreadDetailsControl>
                      }
                    />
                    <TooltipPopup>Unpin</TooltipPopup>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function PinnedMessageRow(props: {
  readonly pin: OrchestrationV2ThreadMessagePin;
  readonly onReveal: () => void;
}) {
  const RoleIcon = props.pin.role === "user" ? UserIcon : BotIcon;
  const excerpt = props.pin.excerpt || "Empty message";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            part="row"
            className="min-w-0 flex-1"
            aria-label={`Go to ${props.pin.role === "user" ? "your" : "assistant"} message: ${excerpt}`}
            onClick={props.onReveal}
          >
            <RoleIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-normal",
                THREAD_DETAILS_PANEL_LABEL_CLASS,
              )}
            >
              {excerpt}
            </span>
          </ThreadDetailsControl>
        }
      />
      <TooltipPopup side="left">{excerpt}</TooltipPopup>
    </Tooltip>
  );
}
