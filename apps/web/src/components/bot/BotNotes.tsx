import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  BOT_FILE_MAX_CHARS,
  type BotFilesReadResult,
  type BotNote,
  type BotNoteSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
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
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { noteSlugFromTitle } from "./BotNotes.logic";

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

function NoteForm(props: {
  threadRef: ScopedThreadRef;
  note: BotNote | null;
  takenSlugs: ReadonlySet<string>;
  canWrite: boolean;
  onSaved: (slug: string) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const writeNote = useAtomCommand(botFilesEnvironment.writeNote, { reportFailure: false });
  const deleteNote = useAtomCommand(botFilesEnvironment.deleteNote, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (title === "") {
      setError(gt("Give the note a title."));
      return;
    }
    const slug = props.note?.slug ?? noteSlugFromTitle(title, props.takenSlugs);
    setBusy(true);
    const message = failureMessage(
      await writeNote({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          slug,
          title,
          summary: String(form.get("summary") ?? "").trim(),
          body: String(form.get("body") ?? ""),
        },
      }),
      gt("An error occurred."),
    );
    setBusy(false);
    setError(message);
    if (message === null) props.onSaved(slug);
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
  const readOnly = !props.canWrite;
  return (
    <form className="flex flex-col gap-2" onSubmit={save}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bot-note-title">
          <T>Title</T>
        </Label>
        <Input
          id="bot-note-title"
          name="title"
          size="sm"
          maxLength={120}
          defaultValue={props.note?.title ?? ""}
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
          name="summary"
          size="sm"
          maxLength={300}
          defaultValue={props.note?.summary ?? ""}
          readOnly={readOnly}
          placeholder={gt("One line, so the Bot knows when to read it.")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bot-note-body">
          <T>Note</T>
        </Label>
        <Textarea
          id="bot-note-body"
          name="body"
          rows={8}
          size="sm"
          maxLength={BOT_FILE_MAX_CHARS}
          defaultValue={props.note?.body ?? ""}
          readOnly={readOnly}
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {readOnly ? null : (
        <div className="flex items-center justify-end gap-2">
          {props.note === null ? null : (
            <Button
              type="button"
              variant="destructive-outline"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              <T>Delete</T>
            </Button>
          )}
          <Button type="submit" size="sm" disabled={busy}>
            <T>Save</T>
          </Button>
        </div>
      )}
    </form>
  );
}

function OpenedNote(props: {
  threadRef: ScopedThreadRef;
  open: OpenNote;
  notes: ReadonlyArray<BotNoteSummary>;
  canWrite: boolean;
  onOpen: (open: OpenNote | null) => void;
}) {
  const note = useEnvironmentQuery(
    props.open.kind === "note"
      ? botFilesEnvironment.note({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId, slug: props.open.slug },
        })
      : null,
  );
  const close = () => props.onOpen(null);
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="ghost-muted" size="xs" className="self-start" onClick={close}>
        <ChevronLeftIcon />
        <T>All notes</T>
      </Button>
      {props.open.kind === "note" && note.data === null ? (
        <p className="text-muted-foreground text-sm">{note.error ?? <T>Loading…</T>}</p>
      ) : (
        <NoteForm
          key={note.dataUpdatedAt}
          threadRef={props.threadRef}
          note={note.data}
          takenSlugs={new Set(props.notes.map((entry) => entry.slug))}
          canWrite={props.canWrite}
          onSaved={(slug) => props.onOpen({ kind: "note", slug })}
          onClose={close}
        />
      )}
    </div>
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
  if (open !== null) {
    return (
      <OpenedNote
        threadRef={props.threadRef}
        open={open}
        notes={props.files.notes}
        canWrite={props.canWrite}
        onOpen={setOpen}
      />
    );
  }
  return (
    <>
      <PreferencesForm
        key={props.files.preferences}
        threadRef={props.threadRef}
        preferences={props.files.preferences}
        canWrite={props.canWrite}
      />
      <NotesList notes={props.files.notes} canWrite={props.canWrite} onOpen={setOpen} />
    </>
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
