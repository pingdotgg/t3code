import { useMemo, useState } from "react";
import type { SharedThread, TurnId } from "@t3tools/contracts";
import {
  AssistantMessageBody,
  AssistantMessageMeta,
  CollapsibleUserMessageBody,
  TimelineRowContainer,
  TurnFoldButton,
  UserMessageBubble,
  UserMessageMeta,
  WorkGroupSection,
  WorkGroupToggleButton,
} from "./MessagesTimeline";
import { deriveMessagesTimelineRows, type WorkGroupScrollAnchor } from "./MessagesTimeline.logic";
import { MessageCopyButton } from "./MessageCopyButton";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { deriveSharedTimelineEntries } from "./SharedConversation.logic";

export function SharedConversation({ share }: { share: SharedThread }) {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [workGroupViewState] = useState(() => ({
    scrollPositions: new Map<string, WorkGroupScrollAnchor>(),
    expandedEntries: new Set<string>(),
  }));
  const timelineEntries = useMemo(() => deriveSharedTimelineEntries(share), [share]);
  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }),
    [timelineEntries, expandedTurnIds, expandedWorkGroupIds],
  );

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
      {rows.map((row) => (
        <TimelineRowContainer key={row.id} row={row}>
          {row.kind === "message" ? (
            row.message.role === "user" ? (
              <div className="group flex flex-col items-end gap-1">
                <UserMessageBubble>
                  <CollapsibleUserMessageBody text={row.message.text} readOnly />
                </UserMessageBubble>
                <UserMessageMeta createdAt={row.message.createdAt} timestampFormat="locale">
                  <MessageCopyButton text={row.message.text} variant="ghost" />
                </UserMessageMeta>
              </div>
            ) : (
              <div className="relative min-w-0 px-1 py-0.5">
                <AssistantMessageBody text={row.message.text} cwd={undefined} readOnly />
                {row.showAssistantMeta && (
                  <AssistantMessageMeta
                    className="mt-1.5"
                    message={row.message}
                    showCopyButton={row.showAssistantCopyButton}
                    copyStreaming={false}
                    timestampFormat="locale"
                  />
                )}
              </div>
            )
          ) : row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
              viewState={workGroupViewState}
              readOnly
            />
          ) : row.kind === "turn-fold" ? (
            <TurnFoldButton
              row={row}
              onToggle={() =>
                setExpandedTurnIds((current) => {
                  const next = new Set(current);
                  if (!next.delete(row.turnId)) next.add(row.turnId);
                  return next;
                })
              }
            />
          ) : row.kind === "work-toggle" ? (
            <WorkGroupToggleButton
              row={row}
              readOnly
              onToggle={() =>
                setExpandedWorkGroupIds((current) => {
                  const next = new Set(current);
                  if (!next.delete(row.groupId)) next.add(row.groupId);
                  return next;
                })
              }
            />
          ) : row.kind === "proposed-plan" ? (
            <div className="min-w-0 px-1 py-0.5">
              <ProposedPlanCard planMarkdown={row.proposedPlan.planMarkdown} readOnly />
            </div>
          ) : row.kind === "assistant-meta" ? (
            <div className="px-1">
              <AssistantMessageMeta
                className="mt-0.5"
                message={row.message}
                showCopyButton={row.showAssistantCopyButton}
                copyStreaming={false}
                timestampFormat="locale"
                alwaysVisible
              />
            </div>
          ) : null}
        </TimelineRowContainer>
      ))}
    </div>
  );
}
