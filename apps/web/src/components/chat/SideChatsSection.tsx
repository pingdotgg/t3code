import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, MessageCircleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useSideChatActions } from "../../hooks/useSideChatActions";
import { useRightPanelStore } from "../../rightPanelStore";
import { isPreviousSideChat, sideChatActivity, sideChatsOf } from "../../sideChat.logic";
import type { SideChatHistoryChoice } from "../../sideChatStore";
import { useThreadShells } from "../../state/entities";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";

/**
 * Side chats of this thread, with the `+` that starts one. It stays visible
 * with none so the `+` is always reachable, and sits beside Lineage rather than
 * inside it: a side chat is presentation, its relationship still shows there.
 */
export function SideChatsSection(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const parentRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const actions = useSideChatActions(parentRef);
  const shells = useThreadShells();
  const [previousExpanded, setPreviousExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const sideChats = useMemo(
    () =>
      sideChatsOf(
        shells.filter((thread) => thread.environmentId === props.environmentId),
        props.threadId,
      ),
    [props.environmentId, props.threadId, shells],
  );
  if (!actions.supported) return null;

  const historyAvailable = actions.historyAvailability.available;
  const unavailableReason = actions.historyAvailability.available
    ? null
    : actions.historyAvailability.reason;
  const defaultChoice: SideChatHistoryChoice =
    actions.lastHistoryChoice === "with" && historyAvailable ? "with" : "without";
  const start = async (history: SideChatHistoryChoice) => {
    if (starting) return;
    setStarting(true);
    actions.rememberHistoryChoice(history);
    try {
      await actions.start({ history });
    } finally {
      setStarting(false);
    }
  };
  // A side chat open in the panel stays listed as active even when idle, so the
  // tab you are looking at is never hidden under a collapsed "Previous".
  const openSurfaces = useRightPanelStore(
    (state) => state.byThreadKey[scopedThreadKey(parentRef)]?.surfaces,
  );
  const openIds = new Set(
    (openSurfaces ?? []).flatMap((surface) => (surface.kind === "aside" ? [surface.threadId] : [])),
  );
  const runningCount = sideChats.filter((thread) => !isPreviousSideChat(thread)).length;
  const active = sideChats.filter(
    (thread) => !isPreviousSideChat(thread) || openIds.has(thread.id),
  );
  const previous = sideChats.filter(
    (thread) => isPreviousSideChat(thread) && !openIds.has(thread.id),
  );

  const renderRow = (thread: (typeof sideChats)[number]) => {
    const activity = sideChatActivity(thread);
    return (
      <li key={thread.id} className="group flex h-9 items-center rounded-lg">
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          className="w-auto min-w-0 flex-1"
          onClick={() => actions.open(thread.id)}
        >
          <ThreadRelationshipIcon
            fallbackIcon={MessageCircleIcon}
            status={activity.status === "idle" ? null : activity.status}
          />
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
            {thread.title}
          </span>
          <span className="sr-only">{activity.status}</span>
          {activity.startedAt ? (
            <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
              <AgentElapsed agent={activity} />
            </span>
          ) : null}
        </ThreadDetailsControl>
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                className="shrink-0 justify-center"
                aria-label={`Discard ${thread.title}`}
                onClick={() => void actions.discard(thread.id)}
              />
            }
          >
            <Trash2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="left">Discard side chat</TooltipPopup>
        </Tooltip>
      </li>
    );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-side-chats-heading"
      title={runningCount > 0 ? `Side chats · ${runningCount} running` : "Side chats"}
      data-side-chats-section
      actions={
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  className="justify-center"
                  aria-label={`Start a side chat ${defaultChoice === "with" ? "with" : "without"} history`}
                  disabled={starting}
                  onClick={() => void start(defaultChoice)}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">
              {defaultChoice === "with" ? "Side chat with history" : "Side chat without history"}
            </TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  className="justify-center"
                  aria-label="Choose side chat type"
                  disabled={starting}
                />
              }
            >
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-60 max-w-(--available-width)">
              <MenuItem disabled={!historyAvailable} onClick={() => void start("with")}>
                <span className="flex flex-col">
                  With history
                  <span className="text-2xs text-muted-foreground">
                    {unavailableReason ?? "Forks from the last finished run"}
                  </span>
                </span>
              </MenuItem>
              <MenuItem onClick={() => void start("without")}>
                <span className="flex flex-col">
                  Without history
                  <span className="text-2xs text-muted-foreground">
                    Linked here, starts from nothing
                  </span>
                </span>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    >
      {sideChats.length === 0 ? (
        <p className="px-1.5 py-1 text-2xs text-muted-foreground">
          Ask a question on the side without interrupting this thread.
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul aria-label="Open side chats" className="m-0 list-none p-0">
          {active.map(renderRow)}
        </ul>
      ) : null}
      {previous.length > 0 ? (
        <div>
          <CollapsibleSectionHeader
            expanded={previousExpanded}
            onClick={() => setPreviousExpanded(!previousExpanded)}
          >
            Previous{!previousExpanded && ` (${previous.length})`}
          </CollapsibleSectionHeader>
          {previousExpanded ? (
            <ul aria-label="Previous side chats" className="m-0 list-none p-0">
              {previous.map(renderRow)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
