import type {
  AgentWorkflowDestinationMode,
  GitResolvedPullRequest,
  ReviewChangesScope,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  GitCompareArrowsIcon,
  GitPullRequestIcon,
  LoaderIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REVIEW_SCOPE_LABELS = {
  uncommitted: "Review uncommitted changes",
  "against-base": "Review against base branch",
  "pull-request": "Review pull request",
} as const satisfies Record<ReviewChangesScope, string>;

/**
 * Long enough that sweeping the pointer down the pull-request list does not
 * fire a `gh` pair per entry, short enough to still cover the pause before a
 * deliberate click.
 */
const PULL_REQUEST_PREWARM_HOVER_DELAY_MS = 120;

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
  onListOpenPullRequests,
  onPrewarmProviderSession,
  onPrewarmReviewPullRequest,
}: {
  readonly action: AgentWorkflowHeaderAction;
  readonly onRun: (request: AgentWorkflowRunRequest) => void;
  readonly onListOpenPullRequests: () => Promise<ReadonlyArray<GitResolvedPullRequest>>;
  readonly onPrewarmProviderSession: () => void;
  readonly onPrewarmReviewPullRequest: (pullRequestNumber: number) => void;
}) {
  const [pullRequests, setPullRequests] = useState<ReadonlyArray<GitResolvedPullRequest> | null>(
    null,
  );
  const [isLoadingPullRequests, setIsLoadingPullRequests] = useState(false);
  const [pullRequestError, setPullRequestError] = useState(false);
  const defaultReviewScope =
    action.kind === "review-code" && action.defaultScope === "pull-request"
      ? "uncommitted"
      : action.kind === "review-code"
        ? action.defaultScope
        : null;
  const disabled = action.isRunning || action.disabledReason !== null;
  const tooltip =
    action.disabledReason ??
    (action.isRunning
      ? `Starting ${action.label}...`
      : action.kind === "review-code"
        ? REVIEW_SCOPE_LABELS[defaultReviewScope!]
        : action.name);
  const loadPullRequests = useCallback(() => {
    if (pullRequests !== null || isLoadingPullRequests) return;
    setIsLoadingPullRequests(true);
    void onListOpenPullRequests()
      .then((result) => {
        setPullRequests(result);
        setPullRequestError(false);
      })
      .catch(() => setPullRequestError(true))
      .finally(() => setIsLoadingPullRequests(false));
  }, [isLoadingPullRequests, onListOpenPullRequests, pullRequests]);

  const prewarmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingPullRequestPrewarm = useCallback(() => {
    if (prewarmTimeoutRef.current === null) return;
    clearTimeout(prewarmTimeoutRef.current);
    prewarmTimeoutRef.current = null;
  }, []);
  useEffect(() => () => cancelPendingPullRequestPrewarm(), [cancelPendingPullRequestPrewarm]);
  const schedulePullRequestPrewarm = useCallback(
    (pullRequestNumber: number) => {
      cancelPendingPullRequestPrewarm();
      prewarmTimeoutRef.current = setTimeout(() => {
        prewarmTimeoutRef.current = null;
        onPrewarmReviewPullRequest(pullRequestNumber);
      }, PULL_REQUEST_PREWARM_HOVER_DELAY_MS);
    },
    [cancelPendingPullRequestPrewarm, onPrewarmReviewPullRequest],
  );
  const runPullRequestReview = useCallback(
    (pullRequestNumber: number) => {
      // A click inside the hover debounce must not leave the timer armed: it
      // would start a second `gh` pair after claim already ran, and park a
      // single-use capture for a later review. Flush now so claim can join.
      cancelPendingPullRequestPrewarm();
      onPrewarmReviewPullRequest(pullRequestNumber);
      onRun({
        workflowId: action.id,
        input: {
          scope: "pull-request",
          pullRequestNumber,
        },
        destinationMode: "child-chat",
      });
    },
    [action.id, cancelPendingPullRequestPrewarm, onPrewarmReviewPullRequest, onRun],
  );

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
            <Group
              aria-label={action.label}
              // The one-click path never opens the menu, so warm the agent on
              // intent instead: session startup dwarfs the review capture.
              onPointerEnter={onPrewarmProviderSession}
              onFocus={onPrewarmProviderSession}
            >
              <Button
                size="icon-xs"
                variant="outline"
                className="border-transparent px-0 shadow-none hover:border-input hover:shadow-xs/5"
                onClick={() => runReview(defaultReviewScope!)}
                disabled={disabled}
                aria-label={REVIEW_SCOPE_LABELS[defaultReviewScope!]}
              >
                {action.isRunning ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <ReviewScopeIcon scope={defaultReviewScope!} className="size-3" />
                )}
                <span className="sr-only">{REVIEW_SCOPE_LABELS[defaultReviewScope!]}</span>
              </Button>
              <GroupSeparator />
              <Menu
                highlightItemOnHover={false}
                onOpenChange={(open) => {
                  // Warm the PR list as soon as the menu opens: `gh pr list` is a
                  // network round trip, and starting it here overlaps it with the
                  // pointer travel to the submenu instead of stalling on it.
                  if (open) {
                    loadPullRequests();
                    onPrewarmProviderSession();
                    return;
                  }
                  cancelPendingPullRequestPrewarm();
                }}
              >
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
                  <MenuSub
                    onOpenChange={(open) => {
                      if (open) {
                        loadPullRequests();
                        return;
                      }
                      // Leaving the submenu without clicking must not fire a
                      // capture the user never asked for.
                      cancelPendingPullRequestPrewarm();
                    }}
                  >
                    <MenuSubTrigger>
                      <GitPullRequestIcon className="size-4" />
                      Open pull requests
                    </MenuSubTrigger>
                    <MenuSubPopup>
                      {isLoadingPullRequests ? (
                        <MenuItem disabled>
                          <LoaderIcon className="size-4 animate-spin" />
                          Loading pull requests...
                        </MenuItem>
                      ) : pullRequestError ? (
                        <MenuItem disabled>Could not load pull requests</MenuItem>
                      ) : pullRequests?.length ? (
                        pullRequests.map((pullRequest) => (
                          <MenuItem
                            key={pullRequest.number}
                            onPointerEnter={() => schedulePullRequestPrewarm(pullRequest.number)}
                            onFocus={() => schedulePullRequestPrewarm(pullRequest.number)}
                            onPointerLeave={cancelPendingPullRequestPrewarm}
                            onBlur={cancelPendingPullRequestPrewarm}
                            onClick={() => runPullRequestReview(pullRequest.number)}
                          >
                            <GitPullRequestIcon className="size-4" />#{pullRequest.number}{" "}
                            {pullRequest.title}
                          </MenuItem>
                        ))
                      ) : pullRequests !== null ? (
                        <MenuItem disabled>No open pull requests</MenuItem>
                      ) : null}
                    </MenuSubPopup>
                  </MenuSub>
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
  onListOpenPullRequests,
  onPrewarmProviderSession,
  onPrewarmReviewPullRequest,
}: {
  readonly actions: ReadonlyArray<AgentWorkflowHeaderAction>;
  readonly onRun: (request: AgentWorkflowRunRequest) => void;
  readonly onListOpenPullRequests: () => Promise<ReadonlyArray<GitResolvedPullRequest>>;
  readonly onPrewarmProviderSession: () => void;
  readonly onPrewarmReviewPullRequest: (pullRequestNumber: number) => void;
}) {
  return actions.map((action) => (
    <AgentWorkflowActionButton
      key={action.id}
      action={action}
      onRun={onRun}
      onListOpenPullRequests={onListOpenPullRequests}
      onPrewarmProviderSession={onPrewarmProviderSession}
      onPrewarmReviewPullRequest={onPrewarmReviewPullRequest}
    />
  ));
}
