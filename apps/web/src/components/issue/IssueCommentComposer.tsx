import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueCommentAudience, IssueRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { ArrowUpIcon, ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { ComposerSurface } from "../chat/ComposerSurface";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

/** The thread composer's card, floating over the issue's timeline, with a comment as its message. */
export function IssueCommentComposer({
  environmentId,
  reference,
  blocked,
  audiences,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Why the viewer cannot comment here; null when they can. */
  blocked: string | null;
  /** Each comment is an internal note unless the viewer picks a reply to the customer. */
  audiences: boolean;
}) {
  const gt = useGT();
  // Internal by default: a customer reply is always an explicit choice.
  const [audience, setAudience] = useState<IssueCommentAudience>("internal");
  // Read at send: a send queued behind dictation goes out with the audience shown then.
  const latestAudience = useRef(audience);
  const changeAudience = (value: IssueCommentAudience) => {
    latestAudience.current = value;
    setAudience(value);
  };
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
    const result = await comment({
      environmentId,
      input: {
        ...reference,
        body: text,
        ...(audiences ? { audience: latestAudience.current } : {}),
      },
    });
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
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3">
      <ComposerSurface.Shell className="pointer-events-auto">
        <ComposerSurface.Host
          className={audiences && audience === "internal" ? "bg-warning-surface" : undefined}
        >
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
              className={cn(
                "field-sizing-content max-h-64 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base text-foreground outline-none wrap-anywhere placeholder:text-muted-foreground/70 disabled:opacity-64 sm:text-sm",
                // Two full lines above the audience row; the padding counts against min-height.
                audiences ? "min-h-[calc(2lh+1rem)]" : "min-h-[2lh]",
              )}
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
              {audiences ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="mr-auto"
                        disabled={locked}
                      />
                    }
                  >
                    {audience === "internal" ? gt("Internal note") : gt("Reply to customer")}
                    <ChevronDownIcon aria-hidden className="size-3" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={audience}
                      onValueChange={(value: IssueCommentAudience) => changeAudience(value)}
                    >
                      <MenuRadioItem value="internal" closeOnClick>
                        {gt("Internal note")}
                      </MenuRadioItem>
                      <MenuRadioItem value="public" closeOnClick>
                        {gt("Reply to customer")}
                      </MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
              ) : null}
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
      {/* The chat composer's bottom inset, so the two cards line up side by side. */}
      <div
        aria-hidden
        className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
      />
    </div>
  );
}
