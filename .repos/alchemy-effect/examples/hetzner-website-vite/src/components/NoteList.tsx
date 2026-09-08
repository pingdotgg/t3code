import type { Note } from "../lib/api.ts";

export const NoteList = ({ notes }: { notes: Note[] }) => {
  if (notes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-slate-400">
        No notes yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {notes.map((note) => (
        <li
          key={note.id}
          className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3"
        >
          <p className="text-slate-100">{note.body}</p>
          <p className="mt-1 text-xs text-slate-500">
            {new Date(note.createdAt).toLocaleString()}
          </p>
        </li>
      ))}
    </ul>
  );
};
