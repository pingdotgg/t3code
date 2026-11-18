import * as Schema from "effect/Schema";

export const THREAD_NOTE_MAX_LENGTH = 10_000;

/** A private user note; blank text means the thread has no note. */
export const ThreadNote = Schema.String.check(Schema.isMaxLength(THREAD_NOTE_MAX_LENGTH));
export type ThreadNote = typeof ThreadNote.Type;

export function normalizeThreadNote(note: string | null): string | null {
  return note === null || note.trim().length === 0 ? null : note;
}
