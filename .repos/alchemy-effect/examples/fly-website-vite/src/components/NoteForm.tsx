import { useState, type FormEvent } from "react";

export const NoteForm = ({
  onCreate,
}: {
  onCreate: (body: string) => Promise<void>;
}) => {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    try {
      await onCreate(trimmed);
      setBody("");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
      <label className="sr-only" htmlFor="note-body">
        Note
      </label>
      <input
        id="note-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write a note…"
        className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none ring-sky-400 focus:ring-2"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl bg-sky-500 px-5 py-3 font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Add note"}
      </button>
    </form>
  );
};
