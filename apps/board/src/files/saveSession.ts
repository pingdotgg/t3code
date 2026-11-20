/**
 * One file being edited. `opened` is what the disk held when the editor opened, `edits` is what the
 * editor holds, and `disk` is what the disk held when a save found it changed. It is null until then.
 */
export interface SaveSession {
  readonly opened: string;
  readonly edits: string;
  readonly disk: string | null;
}

export interface WriteStep {
  readonly kind: "write";
  readonly contents: string;
}

export type SaveStep = WriteStep | { readonly kind: "conflict"; readonly session: SaveSession };

export const openSession = (contents: string): SaveSession => ({
  opened: contents,
  edits: contents,
  disk: null,
});

export const editSession = (session: SaveSession, edits: string): SaveSession => ({
  ...session,
  edits,
});

/** Whether the editor holds something the disk does not. */
export const isDirty = (session: SaveSession): boolean => session.edits !== session.opened;

/** A save writes only over the contents the editor opened. Any other disk contents are a conflict, never overwritten. */
export function save(session: SaveSession, disk: string): SaveStep {
  return disk === session.opened
    ? { kind: "write", contents: session.edits }
    : { kind: "conflict", session: { ...session, disk } };
}

/** Keep mine writes the edits over the disk contents the conflict showed. */
export function keepMine(session: SaveSession): WriteStep {
  return { kind: "write", contents: session.edits };
}

/** Take theirs drops the edits and opens the disk contents the conflict showed. */
export function takeTheirs(session: SaveSession): SaveSession {
  return openSession(session.disk ?? session.opened);
}

/** The session once `contents` is on the disk. */
export const saved = (contents: string): SaveSession => openSession(contents);
