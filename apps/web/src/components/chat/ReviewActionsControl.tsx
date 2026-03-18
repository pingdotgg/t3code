import { useState } from "react";
import type { ThreadId, ReviewRequestSubmitEvent } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, GitPullRequestIcon, XIcon } from "lucide-react";
import { reviewRequestListQueryOptions } from "~/lib/gitReactQuery";
import { readNativeApi } from "~/nativeApi";
import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";

interface ReviewActionsControlProps {
  threadId: ThreadId;
}

export function ReviewActionsControl({ threadId }: ReviewActionsControlProps) {
  const queryClient = useQueryClient();
  const { data } = useQuery(reviewRequestListQueryOptions());
  const [submitting, setSubmitting] = useState<ReviewRequestSubmitEvent | null>(null);

  // Find a review request linked to this thread that is currently in review
  const activeReview = data?.reviewRequests.find(
    (r) => r.threadId === threadId && r.status === "in_review",
  );

  if (!activeReview) return null;

  const handleSubmit = async (event: ReviewRequestSubmitEvent) => {
    const api = readNativeApi();
    if (!api) return;
    setSubmitting(event);
    try {
      await api.reviewRequest.submit({
        id: activeReview.id,
        prUrl: activeReview.prUrl,
        event,
      });
      await queryClient.invalidateQueries({ queryKey: ["reviewRequest"] });
      toastManager.add({
        type: "success",
        title: event === "APPROVE" ? "Review approved" : "Changes requested",
        description: `#${activeReview.prNumber} ${activeReview.prTitle}`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to submit review",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Group aria-label="Review actions">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="outline" size="xs" disabled={submitting !== null}>
              <GitPullRequestIcon className="size-3 text-violet-500" />
              <span className="sr-only md:not-sr-only md:ml-0.5">Review</span>
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          Reviewing #{activeReview.prNumber}: {activeReview.prTitle}
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator className="hidden md:block" />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Review submission options"
              size="icon-xs"
              variant="outline"
              disabled={submitting !== null}
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            className="cursor-pointer hover:bg-accent"
            disabled={submitting !== null}
            onClick={() => void handleSubmit("APPROVE")}
          >
            <CheckIcon className="mr-2 size-3.5 text-emerald-500" />
            {submitting === "APPROVE" ? "Submitting…" : "Approve"}
          </MenuItem>
          <MenuItem
            className="cursor-pointer hover:bg-accent"
            disabled={submitting !== null}
            onClick={() => void handleSubmit("REQUEST_CHANGES")}
          >
            <XIcon className="mr-2 size-3.5 text-orange-500" />
            {submitting === "REQUEST_CHANGES" ? "Submitting…" : "Request Changes"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}
