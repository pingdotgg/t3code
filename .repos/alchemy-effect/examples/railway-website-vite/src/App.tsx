import { useEffect, useState } from "react";
import { NoteForm } from "./components/NoteForm.tsx";
import { NoteList } from "./components/NoteList.tsx";
import { createNote, listNotes, type Note } from "./lib/api.ts";

export const App = ({ platform }: { platform: string }) => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | undefined>();

  const refresh = async () => {
    const next = await listNotes();
    setNotes(next);
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium uppercase tracking-[0.16em] text-sky-400">
          alchemy + {platform}
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Notes</h1>
        <p className="text-slate-400">
          A Tailwind React app that posts to an Effect API backed by Postgres.
        </p>
      </header>
      {error !== undefined ? (
        <p className="rounded-xl border border-rose-900 bg-rose-950/60 px-4 py-3 text-rose-200">
          {error}
        </p>
      ) : undefined}
      <NoteForm
        onCreate={async (body) => {
          setError(undefined);
          const note = await createNote(body);
          setNotes((current) => [note, ...current]);
        }}
      />
      <NoteList notes={notes} />
    </main>
  );
};
