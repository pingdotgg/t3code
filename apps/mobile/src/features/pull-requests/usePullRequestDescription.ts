import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  descriptionDraftInForce,
  settleDescriptionSave,
  startDescriptionSave,
  type DescriptionDraft,
} from "@t3tools/client-runtime/pull-request-editing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail } from "@t3tools/contracts";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

/** The description with checkbox ticks shown before the host confirms them. */
export function usePullRequestDescription(
  params: PullRequestParams,
  pr: PullRequestDetail | null,
  canEdit: boolean,
) {
  const target = pullRequestTarget(params);
  const update = useAtomCommand(composerPullRequests.update, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const reading = useAtomValue(composerPullRequests.detailReadVersion(target));
  const savesRunning = useRef(0);
  const [draft, setDraft] = useState<DescriptionDraft | null>(null);
  const kept = descriptionDraftInForce(draft, pr?.url ?? "", reading);
  if (kept !== draft) setDraft(kept);
  const body = kept?.body ?? pr?.body ?? "";
  const save = async (detail: PullRequestDetail, next: string) => {
    setDraft((current) =>
      startDescriptionSave(current, { url: detail.url, observedAt: reading }, next),
    );
    savesRunning.current += 1;
    const response = await update({ ...target, input: { ...target.input, body: next } });
    savesRunning.current -= 1;
    const saved = !AsyncResult.isFailure(response);
    setDraft((current) => settleDescriptionSave(current, detail.url, saved));
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        "Could not save the description",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
    if (savesRunning.current === 0) refreshDetail();
  };
  return {
    body,
    /** The edit screen starts from the host's copy, so it waits for a reading with the ticks. */
    pending: kept !== null,
    toggleTask:
      canEdit && pr !== null
        ? ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
            const next = setMarkdownTaskChecked(body, markerOffset, checked);
            if (next === body) return false;
            void save(pr, next);
            return true;
          }
        : undefined,
  };
}
