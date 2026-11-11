import { env } from "../../src/Env.ts";
import { Card } from "../components/Card";
import { LocalTime } from "../components/LocalTime";
import { NoteDelete, NotesForm } from "./notes-form";

export const dynamic = "force-dynamic";

type Note = {
  id: string;
  title: string;
  createdAt: number;
};

async function loadNotes(): Promise<Note[]> {
  const res = await env.BACKEND.fetch(new Request("http://localhost/notes"));
  if (!res.ok) {
    throw new Error(`list failed: ${res.status}`);
  }
  const body = (await res.json()) as { notes: Note[] };
  return body.notes;
}

export default async function NotesPage() {
  const notes = await loadNotes();

  return (
    <Card title="Notes">
      <div className="space-y-4">
        <NotesForm />
        <ul data-testid="note-list" className="space-y-2 text-sm">
          {notes.length === 0 ? (
            <li className="text-slate-500">No notes yet.</li>
          ) : (
            notes.map((note) => (
              <li
                key={note.id}
                className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <div>{note.title}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    <LocalTime value={note.createdAt} />
                  </div>
                </div>
                <NoteDelete id={note.id} />
              </li>
            ))
          )}
        </ul>
      </div>
    </Card>
  );
}
