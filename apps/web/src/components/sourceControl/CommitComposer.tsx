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
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  COMMIT_SUBJECT_HARD_LIMIT,
  COMMIT_SUBJECT_SOFT_LIMIT,
  commitPrimaryAction,
  commitPrimaryActionLabel,
  commitSubjectLengthState,
  isCommitPrimaryActionEnabled,
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
  const enabled =
    !props.busy &&
    isCommitPrimaryActionEnabled(action, {
      ...actionInput,
      hasMessage: props.message.trim().length > 0,
    });

  // Turning amend on with an empty draft prefills the last commit message —
  // amending and retyping the message from memory is how subjects drift.
  const { amend, message, onMessageChange, lastCommitMessage } = props;
  useEffect(() => {
    if (amend && message.trim().length === 0 && lastCommitMessage) {
      onMessageChange(lastCommitMessage);
    }
  }, [amend, lastCommitMessage, message, onMessageChange]);

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
        props.onCommitAndPush({ stageAllFirst: props.stagedCount === 0 });
        return;
      }
      runPrimary();
    },
    [props, runPrimary],
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
                onClick={() => props.onCommitAndPush({ stageAllFirst: props.stagedCount === 0 })}
              >
                Commit &amp; push
              </MenuItem>
              <MenuItem onClick={props.onAmend}>Amend last commit</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </div>
  );
}
