/**
 * The commit composer at the top of the Changes view, matching VS Code's SCM
 * flow: write the message, choose options, then commit the groups below.
 *
 * fork: f4 redesign (audit §8 F) — it used to be a fixed ~110px block above the
 * list. It now uses a compact two-line input and a full-width primary action,
 * while still auto-growing for longer messages.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 *  - the primary action **morphs and never disappears** (commit / commit all /
 *    amend / push N). A button that vanishes when the tree goes clean makes the
 *    composer jump under the cursor mid-click.
 *  - it owns the panel's single full-strength primary only when
 *    `sourceControlPrimarySlot` says so; while a merge is stopped on conflicts
 *    the status band's Continue owns it, and the composer steps to `secondary`.
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
import { Checkbox } from "~/components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * The counter is noise at rest — it used to read `0/50` next to Amend in every
 * idle session. It appears once the subject is within eight characters of the
 * soft limit, which is where it starts being information.
 */
const COUNTER_REVEAL_AT = COMMIT_SUBJECT_SOFT_LIMIT - 8;

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
  /**
   * fork: f4 redesign — `default` only when this composer owns the panel's one
   * primary slot; `secondary` otherwise. Decided by `sourceControlPrimarySlot`
   * in the panel, never here, so the header's Sync and the status band's
   * Continue cannot disagree with it.
   */
  readonly primaryVariant: "default" | "secondary";
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
    dirtyCount: props.dirtyCount,
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

  const showCounter = subject.length >= COUNTER_REVEAL_AT;

  return (
    <div
      className="flex flex-none flex-col gap-1.5 border-border/60 border-b bg-muted/10 px-2 py-2"
      data-source-control-commit-composer
    >
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={props.message}
          onChange={(event) => props.onMessageChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder={props.amend ? "Amend the last commit…" : "Message (Ctrl+Enter to commit)"}
          aria-label="Commit message"
          size="sm"
          className={cn(
            "[&_textarea]:max-h-36 [&_textarea]:min-h-12 [&_textarea]:resize-none",
            "[&_textarea]:py-1.5 [&_textarea]:text-sm",
            showCounter && "[&_textarea]:pr-14",
            lengthState === "hard" && "border-destructive/64",
          )}
        />
        {showCounter ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "pointer-events-auto absolute top-1 right-2 text-[11px] tabular-nums",
                    lengthState === "hard"
                      ? "text-destructive-foreground"
                      : lengthState === "soft"
                        ? "text-warning-foreground"
                        : "text-muted-foreground/70",
                  )}
                >
                  {subject.length}/{COMMIT_SUBJECT_SOFT_LIMIT}
                </span>
              }
            />
            <TooltipPopup>
              {`Subject length — soft limit ${COMMIT_SUBJECT_SOFT_LIMIT}, hard limit ${COMMIT_SUBJECT_HARD_LIMIT}. Neither blocks the commit.`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex min-h-6 items-center gap-2 px-0.5">
        {/* fork: f4 redesign (M19) — the repo's Checkbox, not the OS one. */}
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground text-xs">
          <Checkbox
            checked={props.amend}
            onCheckedChange={(checked) => props.onAmendChange(checked === true)}
            aria-label="Amend the last commit"
          />
          Amend
        </label>

        {props.onGenerateMessage === undefined ? null : (
          <Tooltip>
            <TooltipTrigger
              // A disabled control cannot be a tooltip trigger, so the trigger
              // is the span around it — which is how the disabled REASON stays
              // readable. The old code used `title=` for exactly this and lost
              // it the moment the button went disabled.
              render={<span className="inline-flex" />}
            >
              <Button
                size="icon-xs"
                variant="ghost"
                // Disabled but present, always: a button that disappears when
                // the index empties makes the row reflow under the cursor.
                disabled={!generation.enabled}
                onClick={props.onGenerateMessage}
                aria-label={commitMessageGenerationLabel(generation)}
              >
                {props.generating === true ? <Loader2 className="animate-spin" /> : <Sparkles />}
              </Button>
            </TooltipTrigger>
            <TooltipPopup>{commitMessageGenerationLabel(generation)}</TooltipPopup>
          </Tooltip>
        )}

        <span className="ml-auto text-[10px] text-muted-foreground/70">
          {props.stagedCount > 0
            ? `${props.stagedCount} staged`
            : props.dirtyCount > 0
              ? "Commits all changes"
              : "Working tree clean"}
        </span>
      </div>

      {/* VS Code keeps the primary SCM action full-width below the input. */}
      <div className="flex w-full items-center">
        <Button
          size="sm"
          variant={props.primaryVariant}
          disabled={!enabled}
          onClick={runPrimary}
          className="min-w-0 flex-1 justify-center rounded-e-none"
        >
          {commitPrimaryActionLabel(action, props.ahead)}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant={props.primaryVariant}
                disabled={!enabled}
                aria-label="More commit actions"
                className="rounded-s-none border-s-0 px-1.5"
              />
            }
          >
            <ChevronDown className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" sideOffset={6} className="min-w-52">
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
  );
}
