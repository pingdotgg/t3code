import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, IssueDetail, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { appendIssueContext, issueBranchName, issueContextForComposer } from "./issuesPanel.logic";

export function IssueWorkActions({
  environmentId,
  projectId,
  issue,
  composerDraftTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issue: IssueDetail;
  readonly composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
}) {
  const gt = useGT();
  const newThread = useNewThreadHandler();
  const [starting, setStarting] = useState(false);

  const addToDraft = (target: ScopedThreadRef | DraftId) => {
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(target)?.prompt ?? "";
    store.setPrompt(target, appendIssueContext(current, issueContextForComposer(issue)));
  };

  const startWork = async () => {
    if (starting) return;
    setStarting(true);
    const opened = await newThread(scopeProjectRef(environmentId, projectId), {
      branch: issueBranchName(issue),
    }).catch(() => null);
    setStarting(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: gt("Could not open a thread"),
        description: gt("Try again from the project, or open a thread first."),
      });
      return;
    }
    addToDraft(opened.draftId);
    toastManager.add({
      type: "success",
      title: gt("Thread opened"),
      description: gt("The issue is in the composer. Read it over, then send."),
    });
  };

  return (
    <>
      <Button variant="ghost" size="xs" disabled={starting} onClick={() => void startWork()}>
        {starting ? <Loader2 className="size-3 animate-spin" /> : gt("Start work")}
      </Button>
      {composerDraftTarget !== undefined ? (
        <Button variant="ghost" size="xs" onClick={() => addToDraft(composerDraftTarget)}>
          {gt("Add to thread")}
        </Button>
      ) : null}
    </>
  );
}
