import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { ArrowUpIcon } from "lucide-react";
import { useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { ComposerSurface } from "../chat/ComposerSurface";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

/** The thread composer's card, floating over the issue's timeline, with a comment as its message. */
export function IssueCommentComposer({
  environmentId,
  reference,
  blocked,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Why the viewer cannot comment here; null when they can. */
  blocked: string | null;
}) {
  const gt = useGT();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const locked = blocked !== null || submitting;
  const speech = useTextFieldSpeech({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["issue-comment", environmentId, reference]),
    text: body,
    textareaRef,
    onTextChange: setBody,
    disabled: locked,
  });

  const submit = async (text: string) => {
    if (text.trim().length === 0 || locked) return;
    setSubmitting(true);
    const result = await comment({ environmentId, input: { ...reference, body: text } });
    setSubmitting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("The comment could not be posted")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
      return;
    }
    setBody("");
  };
  const submitAfterDictation = () => speech.submitAfterDictation((text) => void submit(text));
  const submitDisabled =
    speech.preparing || (body.trim().length === 0 && !speech.blocksSubmission) || locked;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-3">
      <ComposerSurface.Shell className="pointer-events-auto">
        <ComposerSurface.Host>
          <form
            className="relative z-10 flex flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              submitAfterDictation();
            }}
          >
            <textarea
              ref={textareaRef}
              rows={2}
              className="field-sizing-content max-h-64 min-h-[2lh] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base text-foreground outline-none wrap-anywhere placeholder:text-muted-foreground/70 disabled:opacity-64 sm:text-sm"
              aria-label={gt("Add a comment")}
              placeholder={blocked ?? gt("Leave a comment")}
              value={body}
              // Lock while posting because success clears the draft.
              disabled={locked}
              readOnly={speech.freezesEditor}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
                  event.preventDefault();
                  if (!event.repeat) submitAfterDictation();
                }
              }}
            />
            <div className="flex flex-wrap items-center justify-end gap-2 px-2.5 pb-2.5">
              <TextFieldSpeechControls speech={speech} disabled={locked} />
              <button
                type="submit"
                className="flex size-8 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight hover:scale-105 hover:bg-message-action-hover active:shadow-none active:inset-shadow-control-pressed disabled:pointer-events-none disabled:bg-foreground/12 disabled:text-muted-foreground disabled:shadow-none"
                disabled={submitDisabled}
                aria-label={
                  submitting
                    ? gt("Posting comment")
                    : gt("Comment", { $context: "verb, posts the comment" })
                }
              >
                {submitting ? (
                  <Spinner size="sm" aria-hidden />
                ) : (
                  <ArrowUpIcon aria-hidden className="size-4" />
                )}
              </button>
            </div>
          </form>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
