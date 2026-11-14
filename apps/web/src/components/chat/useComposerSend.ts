import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import { completeComposerSend } from "./composerSendComplete";
import { dispatchComposerSend } from "./composerSendDispatch";
import { resolveComposerSend, type ComposerSendRequest } from "./composerSendResolve";
import { useComposerSendState, type ComposerSendInput } from "./useComposerSendState";

/**
 * Everything the composer's send button can start: a turn on this thread or a new one,
 * a multiple-model start, a queued or steering message, a plan follow-up or implementation
 * thread, a feedback upload, and resuming an interrupted run. Each path restores the draft
 * when it fails.
 */
export function useComposerSend(input: ComposerSendInput) {
  const rt = useComposerSendState(input);

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
    const request: ComposerSendRequest = { dispatchMode, submissionIntent, directAnnotation };
    const plan = await resolveComposerSend(rt, request);
    if (plan.halted) return;
    const handoff = await dispatchComposerSend(rt, plan);
    if (handoff.done) return;
    await completeComposerSend(rt, plan, handoff);
  };

  return { onSend };
}
