import type { AgentWorkflowDestinationMode, ReviewChangesScope } from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  GitCompareArrowsIcon,
  LoaderIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REVIEW_SCOPE_LABELS = {
  uncommitted: "Review uncommitted changes",
  "against-base": "Review against base branch",
} as const satisfies Record<ReviewChangesScope, string>;

export type AgentWorkflowHeaderAction =
  | {
      readonly kind: "review-code";
      readonly id: string;
      readonly label: string;
      readonly defaultScope: ReviewChangesScope;
      readonly disabledReason: string | null;
      readonly isRunning: boolean;
    }
  | {
      readonly kind: "custom";
      readonly id: string;
      readonly label: string;
      readonly name: string;
      readonly destinationMode: AgentWorkflowDestinationMode;
      readonly disabledReason: string | null;
      readonly isRunning: boolean;
    };

export interface AgentWorkflowRunRequest {
  readonly workflowId: string;
  readonly input?: Record<string, unknown>;
  readonly destinationMode?: AgentWorkflowDestinationMode;
}

function ReviewScopeIcon({ scope, className }: { scope: ReviewChangesScope; className: string }) {
  if (scope === "against-base") {
    return <GitCompareArrowsIcon className={className} />;
  }
  return <ClipboardCheckIcon className={className} />;
}

function AgentWorkflowActionButton({
  action,
  onRun,
}: {
  readonly action: AgentWorkflowHeaderAction;
  readonly onRun: (request: AgentWorkflowRunRequest) => void;
}) {
  const disabled = action.isRunning || action.disabledReason !== null;
  const tooltip =
    action.disabledReason ??
    (action.isRunning
      ? `Starting ${action.label}...`
      : action.kind === "review-code"
        ? REVIEW_SCOPE_LABELS[action.defaultScope]
        : action.name);

  if (action.kind === "review-code") {
    const runReview = (scope: ReviewChangesScope) =>
      onRun({
        workflowId: action.id,
        input: { scope },
        destinationMode: "child-chat",
      });

    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Group aria-label={action.label}>
              <Button
                size="icon-xs"
                variant="outline"
                className="border-transparent px-0 shadow-none hover:border-input hover:shadow-xs/5"
                onClick={() => runReview(action.defaultScope)}
                disabled={disabled}
                aria-label={REVIEW_SCOPE_LABELS[action.defaultScope]}
              >
                {action.isRunning ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <ReviewScopeIcon scope={action.defaultScope} className="size-3" />
                )}
                <span className="sr-only">{REVIEW_SCOPE_LABELS[action.defaultScope]}</span>
              </Button>
              <GroupSeparator />
              <Menu highlightItemOnHover={false}>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      className="size-6 border-transparent px-0 shadow-none hover:border-input hover:shadow-xs/5"
                      variant="outline"
                      aria-label={`${action.label} options`}
                      disabled={disabled}
                    />
                  }
                >
                  <ChevronDownIcon className="size-3" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => runReview("uncommitted")}>
                    <ClipboardCheckIcon className="size-4" />
                    Review uncommitted changes
                  </MenuItem>
                  <MenuItem onClick={() => runReview("against-base")}>
                    <GitCompareArrowsIcon className="size-4" />
                    Review against base branch
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </Group>
          }
        />
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="h-6 border-transparent px-2 shadow-none hover:border-input hover:shadow-xs/5"
            style={{ fontSize: "var(--app-chat-font-size)" }}
            onClick={() =>
              onRun({
                workflowId: action.id,
                destinationMode: action.destinationMode,
              })
            }
            disabled={disabled}
            aria-label={action.name}
          >
            {action.isRunning ? (
              <LoaderIcon className="size-2.5 animate-spin" />
            ) : (
              <BotIcon className="size-2.5" />
            )}
            <span className="sr-only @4xl/header-actions:not-sr-only @4xl/header-actions:ml-0.5">
              {action.label}
            </span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function AgentWorkflowHeaderActions({
  actions,
  onRun,
}: {
  readonly actions: ReadonlyArray<AgentWorkflowHeaderAction>;
  readonly onRun: (request: AgentWorkflowRunRequest) => void;
}) {
  return actions.map((action) => (
    <AgentWorkflowActionButton key={action.id} action={action} onRun={onRun} />
  ));
}
