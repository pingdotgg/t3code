import { ComposerBanner } from "./ComposerBanner";
import { memo, useState } from "react";
import { ChevronDownIcon, ListChecksIcon, PencilIcon } from "lucide-react";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ComposerRequestCard, useRequestCardEnterShortcut } from "./ComposerRequestCard";

/**
 * The ready plan as a card above the tray. Build it implements the plan here,
 * its menu implements it in a new thread, and Revise hands the composer over
 * for feedback (a non-empty composer refines instead of implementing).
 */
export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
  planMarkdown,
  stepCount,
  disabled,
  isSending,
  onBuild,
  onBuildInNewThread,
  onRevise,
}: {
  planTitle: string | null;
  planMarkdown?: string;
  stepCount: number;
  disabled: boolean;
  isSending: boolean;
  onBuild: () => void;
  onBuildInNewThread: () => void;
  onRevise: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useRequestCardEnterShortcut(disabled ? null : onBuild);
  const sub = [
    stepCount > 0 ? `${stepCount} ${stepCount === 1 ? "step" : "steps"}` : null,
    planTitle,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ComposerRequestCard.Root data-chat-composer-request-card="plan">
      <ComposerRequestCard.Header
        icon={<ListChecksIcon className="text-ring" />}
        title="Plan ready"
        sub={sub}
        trailing={
          planMarkdown ? (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? "Close plan" : "Open plan"}
            </Button>
          ) : (
            <ComposerRequestCard.Actions>
              <Button size="sm" variant="secondary" onClick={onRevise}>
                <PencilIcon />
                Revise
              </Button>
              <Group data-chat-composer-implement-actions="true">
                <Button
                  size="sm"
                  variant="default"
                  disabled={disabled}
                  aria-keyshortcuts="Enter"
                  onClick={onBuild}
                >
                  {isSending ? "Sending…" : "Build it"}
                  <ComposerRequestCard.EnterKey />
                </Button>
                <GroupSeparator />
                <Menu>
                  <MenuTrigger
                    disabled={disabled}
                    render={
                      <Button
                        size="icon-sm"
                        variant="default"
                        aria-label="Implementation actions"
                      />
                    }
                  >
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
                    <MenuItem disabled={disabled} onClick={onBuildInNewThread}>
                      Implement in a new thread
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </Group>
            </ComposerRequestCard.Actions>
          )
        }
      />
      {planMarkdown && expanded ? (
        <ComposerBanner.Scroll>
          <ComposerRequestCard.Body>
            <ChatMarkdown text={planMarkdown} />
          </ComposerRequestCard.Body>
        </ComposerBanner.Scroll>
      ) : null}
    </ComposerRequestCard.Root>
  );
});
