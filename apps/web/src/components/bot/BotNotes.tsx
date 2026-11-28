import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_GALLERY,
  botAvatarFor,
} from "@t3tools/client-runtime/state/bot-avatar";
import {
  BOT_FILE_MAX_CHARS,
  type BotFilesReadResult,
  type BotNote,
  type BotNoteSummary,
  type BotAvatarChoice,
  type BotAvatarShape,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useThreadGroupingActions } from "~/hooks/useThreadGroupingActions";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { botFilesEnvironment } from "~/state/botFiles";
import { useQuietThreadShell } from "~/state/entities";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { threadEnvironment } from "~/state/threads";
import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { noteSlugFromTitle } from "./BotNotes.logic";
import { BotAvatar } from "./BotAvatar";

type OpenNote = { readonly kind: "new" } | { readonly kind: "note"; readonly slug: string };

function failureMessage(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  return thrownErrorMessage(squashAtomCommandFailure(result), m) ?? fallback;
}

function PreferencesForm(props: {
  threadRef: ScopedThreadRef;
  preferences: string;
  canWrite: boolean;
}) {
  const gt = useGT();
  const write = useAtomCommand(botFilesEnvironment.writePreferences, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState(props.preferences);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const speech = useTextFieldSpeech({
    environmentId: props.threadRef.environmentId,
    ownerKey: JSON.stringify([
      "bot-instructions",
      props.threadRef.environmentId,
      props.threadRef.threadId,
    ]),
    text,
    textareaRef,
    onTextChange: setText,
    disabled: !props.canWrite,
    offerSetup: true,
  });
  const save = (contents: string) => {
    if (contents === props.preferences) return;
    setSaving(true);
    void write({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, contents },
    }).then((result) => {
      setSaving(false);
      const message = failureMessage(result, gt("An error occurred."));
      if (message !== null) {
        toastManager.add({
          type: "error",
          title: gt("Failed to save Bot instructions"),
          description: message,
        });
      }
    });
  };
  const changed = text !== props.preferences || speech.blocksSubmission;
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        speech.submitAfterDictation(save);
      }}
    >
      <Label htmlFor="bot-preferences">
        <T>Instructions</T>
      </Label>
      <div className="flex flex-col rounded-lg bg-muted/40 transition-colors focus-within:bg-muted/60">
        <textarea
          id="bot-preferences"
          ref={textareaRef}
          rows={3}
          maxLength={BOT_FILE_MAX_CHARS}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          readOnly={!props.canWrite || speech.freezesEditor}
          placeholder={gt("How you like the Bot to work.")}
          className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {props.canWrite ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5 px-1.5 pb-1.5">
            <TextFieldSpeechControls speech={speech} />
            {changed ? (
              <Button
                type="submit"
                size="xs"
                disabled={saving || speech.preparing}
                onPointerDown={(event) => event.preventDefault()}
              >
                <T>Save</T>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}

function NoteEditor(props: {
  threadRef: ScopedThreadRef;
  note: BotNote | null;
  takenSlugs: ReadonlySet<string>;
  canWrite: boolean;
  onClose: () => void;
}) {
  const gt = useGT();
  const writeNote = useAtomCommand(botFilesEnvironment.writeNote, { reportFailure: false });
  const deleteNote = useAtomCommand(botFilesEnvironment.deleteNote, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(props.note?.title ?? "");
  const [summary, setSummary] = useState(props.note?.summary ?? "");
  const [body, setBody] = useState(props.note?.body ?? "");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const readOnly = !props.canWrite;
  const speech = useTextFieldSpeech({
    environmentId: props.threadRef.environmentId,
    ownerKey: JSON.stringify([
      "bot-note",
      props.threadRef.environmentId,
      props.threadRef.threadId,
      props.note?.slug ?? null,
    ]),
    text: body,
    textareaRef: bodyRef,
    onTextChange: setBody,
    disabled: readOnly,
    offerSetup: true,
  });
  const save = async (contents: string) => {
    const trimmedTitle = title.trim();
    if (trimmedTitle === "") {
      setError(gt("Give the note a title."));
      return;
    }
    setBusy(true);
    const message = failureMessage(
      await writeNote({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          slug: props.note?.slug ?? noteSlugFromTitle(trimmedTitle, props.takenSlugs),
          title: trimmedTitle,
          summary: summary.trim(),
          body: contents,
        },
      }),
      gt("An error occurred."),
    );
    setBusy(false);
    setError(message);
    if (message === null) props.onClose();
  };
  const remove = async () => {
    const note = props.note;
    if (note === null) return;
    const confirmed = await readLocalApi()
      ?.dialogs.confirm(gt('Delete note "{title}"?', { title: note.title }), {
        variant: "destructive",
      })
      .catch(() => false);
    if (!confirmed) return;
    setBusy(true);
    const message = failureMessage(
      await deleteNote({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, slug: note.slug },
      }),
      gt("An error occurred."),
    );
    setBusy(false);
    setError(message);
    if (message === null) props.onClose();
  };
  return (
    <form
      className="contents"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        speech.submitAfterDictation((contents) => void save(contents));
      }}
    >
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-note-title">
              <T>Title</T>
            </Label>
            <Input
              id="bot-note-title"
              size="sm"
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              readOnly={readOnly}
              autoFocus={props.note === null}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-note-summary">
              <T>Summary</T>
            </Label>
            <Input
              id="bot-note-summary"
              size="sm"
              maxLength={300}
              value={summary}
              onChange={(event) => setSummary(event.currentTarget.value)}
              readOnly={readOnly}
              placeholder={gt("One line, so the Bot knows when to read it.")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-note-body">
              <T>Note</T>
            </Label>
            <div className="flex flex-col rounded-lg bg-muted/40 transition-colors focus-within:bg-muted/60">
              <textarea
                id="bot-note-body"
                ref={bodyRef}
                maxLength={BOT_FILE_MAX_CHARS}
                value={body}
                onChange={(event) => setBody(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                readOnly={readOnly || speech.freezesEditor}
                className="field-sizing-content block max-h-[50vh] min-h-48 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              {readOnly ? null : (
                <div className="flex flex-wrap items-center justify-end gap-1.5 px-1.5 pb-1.5">
                  <TextFieldSpeechControls speech={speech} />
                </div>
              )}
            </div>
          </div>
          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </DialogPanel>
      <DialogFooter>
        {readOnly || props.note === null ? null : (
          <Button
            type="button"
            variant="ghost-destructive"
            size="sm"
            className="sm:mr-auto"
            disabled={busy}
            onClick={() => void remove()}
          >
            <T>Delete</T>
          </Button>
        )}
        <DialogClose render={<Button type="button" variant="outline" size="sm" />}>
          <T>Cancel</T>
        </DialogClose>
        {readOnly ? null : (
          <Button type="submit" size="sm" disabled={busy || speech.preparing}>
            <T>Save</T>
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

function NoteDialog(props: {
  threadRef: ScopedThreadRef;
  open: OpenNote | null;
  notes: ReadonlyArray<BotNoteSummary>;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { open } = props;
  const note = useEnvironmentQuery(
    open?.kind === "note"
      ? botFilesEnvironment.note({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId, slug: open.slug },
        })
      : null,
  );
  const loading = open?.kind === "note" && note.data === null;
  return (
    <Dialog open={open !== null} onOpenChange={(next) => (next ? null : props.onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{open?.kind === "new" ? <T>New note</T> : <T>Edit note</T>}</DialogTitle>
        </DialogHeader>
        {open === null ? null : loading ? (
          <DialogPanel>
            <p className="text-muted-foreground text-sm">{note.error ?? <T>Loading…</T>}</p>
          </DialogPanel>
        ) : (
          <NoteEditor
            key={open.kind === "note" ? `${open.slug}:${note.dataUpdatedAt}` : "new"}
            threadRef={props.threadRef}
            note={open.kind === "note" ? note.data : null}
            takenSlugs={new Set(props.notes.map((entry) => entry.slug))}
            canWrite={props.canWrite}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function NotesList(props: {
  notes: ReadonlyArray<BotNoteSummary>;
  canWrite: boolean;
  onOpen: (open: OpenNote) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label render={<span />}>
          <T>Notes</T>
        </Label>
        {props.canWrite ? (
          <Button
            type="button"
            variant="ghost-muted"
            size="xs"
            onClick={() => props.onOpen({ kind: "new" })}
          >
            <PlusIcon />
            <T>New note</T>
          </Button>
        ) : null}
      </div>
      {props.notes.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          <T>The Bot keeps its notes here.</T>
        </p>
      ) : (
        <ul className="-mx-2.5 flex flex-col">
          {props.notes.map((note) => (
            <li key={note.slug}>
              <button
                type="button"
                onClick={() => props.onOpen({ kind: "note", slug: note.slug })}
                className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-foreground">{note.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    <RelativeTime timestamp={note.updatedAt} />
                  </span>
                </span>
                {note.summary === "" ? null : (
                  <span className="w-full truncate text-muted-foreground">{note.summary}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BotFiles(props: {
  threadRef: ScopedThreadRef;
  files: BotFilesReadResult;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState<OpenNote | null>(null);
  return (
    <>
      <PreferencesForm
        key={props.files.preferences}
        threadRef={props.threadRef}
        preferences={props.files.preferences}
        canWrite={props.canWrite}
      />
      <NotesList notes={props.files.notes} canWrite={props.canWrite} onOpen={setOpen} />
      <NoteDialog
        threadRef={props.threadRef}
        open={open}
        notes={props.files.notes}
        canWrite={props.canWrite}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function AvatarPicker(props: {
  threadRef: ScopedThreadRef;
  choice: BotAvatarChoice | null;
  canWrite: boolean;
}) {
  const gt = useGT();
  const setAvatar = useOrchestrationCommand(threadEnvironment.setBotAvatar, {
    reportFailure: false,
  });
  const current = botAvatarFor(props.threadRef.threadId, props.choice);
  const pick = (avatar: BotAvatarChoice) =>
    void setAvatar({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, botAvatar: avatar },
    }).then((result) => {
      const message = failureMessage(result, gt("An error occurred."));
      if (message !== null) {
        toastManager.add({
          type: "error",
          title: gt("Failed to update Bot"),
          description: message,
        });
      }
    });
  return (
    <div className="flex items-center justify-between gap-3">
      <Label render={<span />}>
        <T>Avatar</T>
      </Label>
      <Popover>
        <PopoverTrigger
          disabled={!props.canWrite}
          render={<Button type="button" variant="ghost-muted" size="icon-sm" />}
          aria-label={gt("Change avatar")}
        >
          <BotAvatar
            threadId={props.threadRef.threadId}
            choice={props.choice}
            state="idle"
            size={20}
          />
        </PopoverTrigger>
        <PopoverPopup side="left" align="start" className="w-64">
          <div className="grid grid-cols-6 gap-1">
            {BOT_AVATAR_GALLERY.map((avatar) => {
              const shape = avatar.definition.id as BotAvatarShape;
              const selected = shape === current.definition.id;
              return (
                <button
                  key={shape}
                  type="button"
                  aria-label={avatar.definition.name}
                  aria-pressed={selected}
                  onClick={() => pick({ shape, color: current.color })}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected && "bg-accent",
                  )}
                >
                  <BotAvatar
                    threadId={props.threadRef.threadId}
                    choice={{ shape, color: current.color }}
                    state="idle"
                    size={24}
                  />
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
            {BOT_AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={color === current.color}
                onClick={() => pick({ shape: current.definition.id as BotAvatarShape, color })}
                className={cn(
                  "size-5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
                  color === current.color && "ring-2 ring-inset ring-foreground/70",
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

/** A Bot's instructions, notes and worker muting, on its page. */
export function BotNotes(props: { threadRef: ScopedThreadRef }) {
  const thread = useQuietThreadShell(props.threadRef);
  const canWrite = useAtomValue(
    botFilesEnvironment.writeNote.permissionAtom(props.threadRef.environmentId),
  );
  const { setMuteWorkers } = useThreadGroupingActions();
  const files = useEnvironmentQuery(
    botFilesEnvironment.files({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    }),
  );
  // The Bot writes its memory through its own tools during a turn, which bumps nothing this
  // query reads, so each finished turn asks again.
  const turnCompletedAt = thread?.latestRun?.completedAt ?? null;
  const refreshFiles = files.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads server files the Bot changed outside this client
  useEffect(() => {
    if (turnCompletedAt !== null) refreshFiles();
  }, [turnCompletedAt, refreshFiles]);
  const botConfig = thread?.botConfig;
  if (botConfig == null) return null;
  return (
    <div className="flex flex-col gap-3 px-2.5">
      <AvatarPicker
        threadRef={props.threadRef}
        choice={botConfig.avatar ?? null}
        canWrite={canWrite}
      />
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="bot-mute-workers">
          <T>Mute worker updates</T>
        </Label>
        <Switch
          id="bot-mute-workers"
          size="sm"
          checked={botConfig.muteChildren}
          disabled={!canWrite}
          onCheckedChange={(checked) => void setMuteWorkers(props.threadRef, checked)}
        />
      </div>
      {files.data === null ? (
        <p className="text-muted-foreground text-sm">{files.error ?? <T>Loading…</T>}</p>
      ) : (
        <BotFiles threadRef={props.threadRef} files={files.data} canWrite={canWrite} />
      )}
    </div>
  );
}
