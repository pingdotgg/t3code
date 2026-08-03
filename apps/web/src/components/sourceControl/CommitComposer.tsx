/**
 * The commit composer: pinned at the TOP of the Changes tab, flex-none.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 *  - the primary action **morphs and never disappears** (commit / commit all /
 *    amend / push N). A button that vanishes when the tree goes clean makes the
 *    composer jump under the cursor mid-click.
 *  - while a merge/rebase is stopped on conflicts it steps down to `secondary`,
 *    so the Conflicts section's Continue owns the one solid slot on screen.
 *
 * The draft itself is stored per **cwd** by `sourceControlStore`, never per
 * thread — see the note there.
 *
 * fork: f4 source-control panel
 */
import { ChevronDown, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  COMMIT_SUBJECT_HARD_LIMIT,
  COMMIT_SUBJECT_SOFT_LIMIT,
  commitMessageGenerationLabel,
  commitMessageGenerationState,
  commitPrimaryAction,
  commitPrimaryActionLabel,
  commitSubjectLengthState,
  isAmendCommitEnabled,
  isCommitAndPushEnabled,
  isCommitPrimaryActionEnabled,
  shouldPrefillAmendMessage,
  splitCommitMessage,
} from "@t3tools/client-runtime/state/working-copy-logic";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

export interface CommitComposerProps {
  readonly message: string;
  readonly onMessageChange: (message: string) => void;
  readonly amend: boolean;
  readonly onAmendChange: (amend: boolean) => void;
  /** Prefill for the amend toggle, from `workingCopy.lastCommitMessage`. */
  readonly lastCommitMessage: string | null;
  readonly stagedCount: number;
  readonly dirtyCount: number;
  readonly ahead: number;
  readonly operationInProgress: boolean;
  readonly busy: boolean;
  readonly onCommit: (options: { readonly stageAllFirst: boolean }) => void;
  readonly onAmend: () => void;
  readonly onPush: () => void;
  readonly onCommitAndPush: (options: { readonly stageAllFirst: boolean }) => void;
  /**
   * fork: f4 AI commit message. Absent = the button is not rendered at all
   * (a surface with no generation wired). Present = it renders, and its own
   * enablement is decided from the props below.
   */
  readonly onGenerateMessage?: (() => void) | undefined;
  readonly generating?: boolean | undefined;
  /** `null` while the server config is in flight — treated as "let it try". */
  readonly textGenerationConfigured?: boolean | null | undefined;
}

export function CommitComposer(props: CommitComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { subject } = splitCommitMessage(props.message);
  const lengthState = commitSubjectLengthState(subject);

  const actionInput = useMemo(
    () => ({
      amend: props.amend,
      stagedCount: props.stagedCount,
      dirtyCount: props.dirtyCount,
      ahead: props.ahead,
    }),
    [props.ahead, props.amend, props.dirtyCount, props.stagedCount],
  );
  const action = commitPrimaryAction(actionInput);
  const hasMessage = props.message.trim().length > 0;
  const enabled =
    !props.busy && isCommitPrimaryActionEnabled(action, { ...actionInput, hasMessage });
  // fork: f4 F-07 — one predicate per entry point, applied to the button, the
  // two keyboard paths and both menu items.
  const commitAndPushEnabled = isCommitAndPushEnabled({
    ...actionInput,
    hasMessage,
    busy: props.busy,
  });
  const amendEnabled = isAmendCommitEnabled({
    busy: props.busy,
    hasLastCommit: props.lastCommitMessage !== null,
  });

  // fork: f4 AI commit message — enablement and its reason are one pure
  // decision, so the tooltip can never disagree with the disabled state.
  const generation = commitMessageGenerationState({
    hasScope: props.onGenerateMessage !== undefined,
    stagedCount: props.stagedCount,
    amend: props.amend,
    generating: props.generating === true,
    busy: props.busy,
    modelConfigured: props.textGenerationConfigured ?? null,
  });

  // Turning amend on with an empty draft prefills the last commit message —
  // amending and retyping the message from memory is how subjects drift.
  //
  // fork: f4 F-03 — this is a prefill on the off→on TRANSITION, not a render
  // invariant. With `message` in the dependency list and no edge guard the
  // effect refilled the box the instant it went empty, so the draft could never
  // be cleared or edited down while Amend was ticked.
  const { amend, message, onMessageChange, lastCommitMessage } = props;
  const messageRef = useRef(message);
  messageRef.current = message;
  const prefilledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!amend) {
      // Re-arm, so toggling amend off and on again prefills once more.
      prefilledForRef.current = null;
      return;
    }
    const fill = shouldPrefillAmendMessage({
      amend,
      message: messageRef.current,
      lastCommitMessage,
      prefilledFor: prefilledForRef.current,
    });
    // Mark the session as prefilled either way: the user having typed something
    // is exactly as final an answer as having filled the box for them.
    prefilledForRef.current = lastCommitMessage;
    if (fill && lastCommitMessage !== null) onMessageChange(lastCommitMessage);
  }, [amend, lastCommitMessage, onMessageChange]);

  const runPrimary = useCallback(() => {
    if (!enabled) return;
    switch (action) {
      case "amend":
        props.onAmend();
        return;
      case "push":
        props.onPush();
        return;
      case "commit":
        props.onCommit({ stageAllFirst: false });
        return;
      case "commit-all":
        props.onCommit({ stageAllFirst: true });
        return;
    }
  }, [action, enabled, props]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (event.shiftKey) {
        // fork: f4 F-07 — this branch used to bypass every gate.
        if (!commitAndPushEnabled) return;
        props.onCommitAndPush({ stageAllFirst: props.stagedCount === 0 });
        return;
      }
      runPrimary();
    },
    [commitAndPushEnabled, props, runPrimary],
  );

  return (
    <div className="flex flex-none flex-col gap-2 border-border/60 border-b p-2">
      <Textarea
        ref={textareaRef}
        value={props.message}
        onChange={(event) => props.onMessageChange(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder={props.amend ? "Amend the last commit…" : "Commit message"}
        aria-label="Commit message"
        className={cn(
          "min-h-16 resize-none text-sm",
          lengthState === "hard" && "ring-1 ring-destructive",
        )}
      />
      <div className="flex items-center gap-2">
        {props.onGenerateMessage === undefined ? null : (
          <button
            type="button"
            // Disabled but present, always: a button that disappears when the
            // index empties makes the row reflow under the cursor, which is the
            // same reason the primary action morphs instead of vanishing.
            disabled={!generation.enabled}
            onClick={props.onGenerateMessage}
            aria-label={commitMessageGenerationLabel(generation)}
            title={commitMessageGenerationLabel(generation)}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground",
              "hover:bg-accent hover:text-foreground",
              // NOT `pointer-events-none` while disabled: that suppresses the
              // native tooltip, and the tooltip IS the disabled reason.
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            {props.generating === true ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
          </button>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs">
          <input
            type="checkbox"
            checked={props.amend}
            onChange={(event) => props.onAmendChange(event.target.checked)}
          />
          Amend
        </label>
        <span
          className={cn(
            "text-xs tabular-nums",
            lengthState === "hard"
              ? "text-destructive-foreground"
              : lengthState === "soft"
                ? "text-amber-500"
                : "text-muted-foreground/70",
          )}
          title={`Subject: soft limit ${COMMIT_SUBJECT_SOFT_LIMIT}, hard limit ${COMMIT_SUBJECT_HARD_LIMIT}`}
        >
          {subject.length}/{COMMIT_SUBJECT_SOFT_LIMIT}
        </span>
        <div className="ml-auto flex items-center">
          <Button
            size="sm"
            // Conflicts' Continue owns the single solid slot while an operation
            // is stopped mid-flight.
            variant={props.operationInProgress ? "secondary" : "default"}
            disabled={!enabled}
            onClick={runPrimary}
            className="rounded-r-none"
          >
            {commitPrimaryActionLabel(action, props.ahead)}
          </Button>
          <Menu>
            <MenuTrigger
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-r-[var(--control-radius)] border border-l-0 px-1.5 sm:h-7",
                props.operationInProgress
                  ? "border-transparent bg-secondary text-secondary-foreground"
                  : "border-primary bg-primary text-primary-foreground",
              )}
              aria-label="More commit actions"
            >
              <ChevronDown className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-52">
              <MenuItem
                disabled={!commitAndPushEnabled}
                onClick={() => props.onCommitAndPush({ stageAllFirst: props.stagedCount === 0 })}
              >
                Commit &amp; push
              </MenuItem>
              <MenuItem disabled={!amendEnabled} onClick={props.onAmend}>
                Amend last commit
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </div>
  );
}
