import type { EnvironmentId, PullRequestRef, PullRequestReviewThread } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { WandSparklesIcon } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";

import { useThreadShell } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { MarkdownCodeBlockActionContext } from "../ChatMarkdown";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestMarkdownContext } from "./PullRequestMarkdown";
import {
  parseReviewSuggestions,
  sliceFileLines,
  suggestionIndexFromMeta,
  suggestionLineRange,
} from "./pullRequestSuggestion.logic";

/**
 * Wraps a review comment's markdown so each ```suggestion block's header offers "Apply". That
 * writes the suggested lines into the checkout without committing, and only while the checkout
 * is on the pull request's head branch and the lines still read as they do on the host. The
 * checkout is the chat thread's worktree when the panel sits beside one of this project's
 * threads, else the project itself.
 */
export function PullRequestSuggestionScope(props: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  thread: PullRequestReviewThread | undefined;
  body: string;
  headBranch: string;
  workspaceRoot: string;
  children: ReactNode;
}) {
  // Most comments carry no suggestion; they skip the checkout's status query entirely.
  if (props.thread === undefined || parseReviewSuggestions(props.body).length === 0) {
    return props.children;
  }
  return <SuggestionActions {...props} thread={props.thread} />;
}

function SuggestionActions({
  environmentId,
  reference,
  thread,
  body,
  headBranch,
  workspaceRoot,
  children,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  thread: PullRequestReviewThread;
  body: string;
  headBranch: string;
  workspaceRoot: string;
  children: ReactNode;
}) {
  const suggestions = parseReviewSuggestions(body);
  const range = suggestionLineRange(thread);
  const threadRef = useContext(PullRequestMarkdownContext)?.threadRef ?? null;
  const chatThread = useThreadShell(
    threadRef !== null && threadRef.environmentId === environmentId ? threadRef : null,
  );
  const cwd =
    (chatThread?.projectId === reference.projectId ? chatThread.worktreePath : null) ??
    workspaceRoot;
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const readHead = useAtomCommand(pullRequestEnvironment.diffFileContents, {
    reportFailure: false,
  });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const branch = status.data?.refName ?? null;
  const blocked =
    range === null
      ? "These lines are no longer in the diff, so there is nothing to apply this to."
      : branch !== headBranch
        ? `Check out ${headBranch} to apply this suggestion.`
        : null;

  const apply = async (replacement: string) => {
    if (range === null || pending) return;
    setPending(true);
    try {
      const head = await readHead({
        environmentId,
        input: {
          ...reference,
          // Only the head side is read, which also covers a file the pull request adds.
          changeType: "new",
          oldPath: thread.path,
          newPath: thread.path,
        },
      });
      const expected =
        head._tag === "Success" ? sliceFileLines(head.value.newContents, range) : null;
      if (expected === null) {
        toastManager.add({ type: "error", title: "Could not read these lines from the host" });
        return;
      }
      // The branch shown can lag a checkout switched since, so it is read again before writing.
      const current = await refreshStatus({ environmentId, input: { cwd } });
      if (current._tag === "Failure" || current.value.refName !== headBranch) {
        toastManager.add({
          type: "error",
          title:
            current._tag === "Failure"
              ? "Could not read the checkout's branch"
              : `Check out ${headBranch} to apply this suggestion`,
        });
        return;
      }
      const written = await writeFile({
        environmentId,
        input: {
          cwd,
          relativePath: thread.path,
          contents: replacement,
          replaceLines: { ...range, expected },
        },
      });
      if (written._tag === "Failure") {
        const error = Cause.squash(written.cause);
        const failure =
          typeof error === "object" && error !== null && "failure" in error ? error.failure : null;
        if (failure === "lines_already_replaced") {
          toastManager.add({
            type: "info",
            title: "Already applied",
            description: `${thread.path} already has this suggestion.`,
          });
          return;
        }
        toastManager.add({
          type: "error",
          title: "Could not apply the suggestion",
          description:
            failure === "lines_changed"
              ? `${thread.path} differs from the pull request here. Pull or push the branch, then try again.`
              : undefined,
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "Suggestion applied",
        description: `${thread.path} changed in your checkout. Nothing was committed.`,
      });
    } finally {
      setPending(false);
    }
  };

  const renderAction = (meta: string | undefined) => {
    const index = suggestionIndexFromMeta(meta);
    const replacement = index === null ? undefined : suggestions[index];
    if (replacement === undefined) return null;
    const button = (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={blocked !== null || pending}
        onClick={() => void apply(replacement)}
      >
        <WandSparklesIcon className="size-3" />
        {pending ? "Applying..." : "Apply suggestion"}
      </Button>
    );
    return (
      <Tooltip>
        {/* A disabled button takes no pointer events, so the wrapper carries the tooltip. */}
        <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
        <TooltipPopup side="top">
          {blocked ?? "Apply this suggestion to your checkout"}
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <MarkdownCodeBlockActionContext value={renderAction}>{children}</MarkdownCodeBlockActionContext>
  );
}
