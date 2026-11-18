import { useAtomValue } from "@effect/atom-react";
import {
  normalizeThreadNote,
  THREAD_NOTE_MAX_LENGTH,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { StickyNoteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { T, useGT } from "gt-react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadNoteSave } from "./useThreadNoteSave";

const COUNTER_THRESHOLD = THREAD_NOTE_MAX_LENGTH - 1_000;

/** Which thread has its note open; the command palette opens it from outside the header. */
const threadNoteOpenAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-note:open-thread"),
);

export function openThreadNote(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadNoteOpenAtom, threadRef);
}

function closeThreadNote(): void {
  appAtomRegistry.set(threadNoteOpenAtom, null);
}

export function ThreadNoteButton({
  threadRef,
  canEdit,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly canEdit: boolean;
}) {
  const gt = useGT();
  const openThread = useAtomValue(threadNoteOpenAtom);
  const open =
    openThread !== null &&
    openThread.environmentId === threadRef.environmentId &&
    openThread.threadId === threadRef.threadId;
  const unsavedRef = useRef<{ text: string | null; save: (text: string) => void } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the shared popover owner when navigating away from this thread
  useEffect(
    () => () => {
      const unsaved = unsavedRef.current;
      if (unsaved?.text != null) unsaved.save(unsaved.text);
      const current = appAtomRegistry.get(threadNoteOpenAtom);
      if (
        current?.environmentId === threadRef.environmentId &&
        current.threadId === threadRef.threadId
      )
        closeThreadNote();
    },
    [threadRef.environmentId, threadRef.threadId],
  );
  // Null means untouched, so a popover opened from the command palette shows the current note.
  const [draft, setDraft] = useState<string | null>(null);
  const { note, save, beginEdit, changeDraft } = useThreadNoteSave(
    threadRef,
    canEdit,
    (unsaved) => {
      // Reopen with the unsaved text so a failed save never loses it.
      setDraft(unsaved);
      if (unsavedRef.current) unsavedRef.current.text = unsaved;
      openThreadNote(threadRef);
    },
  );
  const text = draft ?? note;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasNote = normalizeThreadNote(note) !== null;
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) {
          beginEdit();
          openThreadNote(threadRef);
          return;
        }
        if (eventDetails.reason !== "escape-key") save(text);
        else changeDraft();
        if (unsavedRef.current) unsavedRef.current.text = null;
        setDraft(null);
        closeThreadNote();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={hasNote ? gt("Thread note (has note)") : gt("Thread note")}
                  data-has-note={hasNote || undefined}
                  className="relative shrink-0"
                />
              }
            />
          }
        >
          <StickyNoteIcon aria-hidden />
          {hasNote ? (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
              data-thread-note-dot
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">
          <T>Thread note</T>
        </TooltipPopup>
      </Tooltip>
      {open ? (
        <PopoverPopup
          align="start"
          width="md"
          padding="compact"
          initialFocus={() => {
            beginEdit();
            const textarea = textareaRef.current;
            textarea?.focus({ preventScroll: true });
            textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
            return false;
          }}
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <PopoverTitle>
                <T>Thread note</T>
              </PopoverTitle>
              <p className="text-muted-foreground text-xs">
                <T>Only visible to you. Not sent to the agent.</T>
              </p>
            </div>
            <Textarea
              size="sm"
              rows={5}
              aria-label={gt("Thread note")}
              placeholder={gt("Add a note for this thread…")}
              ref={textareaRef}
              maxLength={THREAD_NOTE_MAX_LENGTH}
              readOnly={!canEdit}
              value={text}
              onChange={(event) => {
                changeDraft();
                setDraft(event.currentTarget.value);
                unsavedRef.current = { text: event.currentTarget.value, save };
              }}
              onBlur={(event) => {
                // Closing the popover saves; this covers leaving the window with it open.
                if (!document.hasFocus()) save(event.currentTarget.value);
              }}
            />
            <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
              <span>
                {canEdit ? gt("Saves when you click away · Esc to cancel") : gt("Read only")}
              </span>
              {text.length > COUNTER_THRESHOLD ? (
                <span className="tabular-nums">
                  {text.length.toLocaleString()} / {THREAD_NOTE_MAX_LENGTH.toLocaleString()}
                </span>
              ) : null}
            </div>
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
