import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadEntryPin,
  type OrchestrationV2ThreadEntryPinKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import {
  BotIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  PanelsTopLeftIcon,
  PinIcon,
  PinOffIcon,
  UserIcon,
} from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useThreadEntryPins } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSetEntryPin } from "./EntryPinButton";
import { revealThreadEntry } from "./entryReveal";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadEntryPinsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const pins = useThreadEntryPins(threadRef);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const setEntryPin = useSetEntryPin(threadRef);
  const [expanded, setExpanded] = useLocalStorage(
    "t3code:thread-details:entry-pins-expanded",
    false,
    Schema.Boolean,
  );
  if (pins.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-entry-pins-heading"
      title={gt("Pinned items")}
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
            <T>Pinned items</T>
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
              <li key={pin.entryId} className="flex items-center gap-1">
                <PinnedEntryRow
                  pin={pin}
                  onReveal={() => void revealThreadEntry(threadRef, pin.entryId)}
                />
                {canOperate ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          aria-label={unpinLabel(pin.kind, gt)}
                          onClick={() => void setEntryPin(pin.entryId, false)}
                        >
                          <PinOffIcon className="size-3.5" />
                        </ThreadDetailsControl>
                      }
                    />
                    <TooltipPopup>
                      {gt("Unpin", { $context: "verb, unpin a timeline entry" })}
                    </TooltipPopup>
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

const PIN_KIND_ICONS = {
  user_message: UserIcon,
  assistant_message: BotIcon,
  html_render: PanelsTopLeftIcon,
  proposed_plan: ClipboardListIcon,
} satisfies Record<OrchestrationV2ThreadEntryPinKind, unknown>;

function unpinLabel(kind: OrchestrationV2ThreadEntryPinKind, gt: ReturnType<typeof useGT>): string {
  switch (kind) {
    case "user_message":
      return gt("Unpin your message");
    case "assistant_message":
      return gt("Unpin assistant message");
    case "html_render":
      return gt("Unpin visual");
    case "proposed_plan":
      return gt("Unpin plan");
  }
}

function revealLabel(
  kind: OrchestrationV2ThreadEntryPinKind,
  excerpt: string,
  gt: ReturnType<typeof useGT>,
): string {
  switch (kind) {
    case "user_message":
      return gt("Go to your message: {excerpt}", { excerpt });
    case "assistant_message":
      return gt("Go to assistant message: {excerpt}", { excerpt });
    case "html_render":
      return gt("Go to visual: {excerpt}", { excerpt });
    case "proposed_plan":
      return gt("Go to plan: {excerpt}", { excerpt });
  }
}

function PinnedEntryRow(props: {
  readonly pin: OrchestrationV2ThreadEntryPin;
  readonly onReveal: () => void;
}) {
  const gt = useGT();
  const KindIcon = PIN_KIND_ICONS[props.pin.kind];
  const excerpt = props.pin.label || gt("Empty message");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            size="xs"
            variant="ghost"
            part="row"
            className="min-w-0 flex-1"
            aria-label={revealLabel(props.pin.kind, excerpt, gt)}
            onClick={props.onReveal}
          >
            <KindIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
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
