"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NotesForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function addNote() {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Title is required.");
      return;
    }
    setError(null);
    try {
      const created = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!created.ok) {
        throw new Error(`create failed: ${created.status}`);
      }
      setTitle("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-2">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addNote();
        }}
      >
        <input
          data-testid="note-title"
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          data-testid="note-save"
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
        >
          Add
        </button>
      </form>
      {error ? (
        <p data-testid="note-status" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function NoteDelete({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function deleteNote() {
    setError(null);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(`delete failed: ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <span className="shrink-0 text-right">
      <button
        data-testid="note-delete"
        type="button"
        className="text-sm text-slate-500 underline"
        onClick={() => void deleteNote()}
      >
        Delete
      </button>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </span>
  );
}
