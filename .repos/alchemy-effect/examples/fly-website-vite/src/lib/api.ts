export type Note = {
  id: number;
  body: string;
  createdAt: string;
};

const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

const url = (path: string) => `${base}${path}`;

export const listNotes = async (): Promise<Note[]> => {
  const response = await fetch(url("/notes"));
  if (!response.ok) {
    throw new Error(`GET /notes failed: ${response.status}`);
  }
  const payload = (await response.json()) as { notes: Note[] };
  return payload.notes;
};

export const createNote = async (body: string): Promise<Note> => {
  const response = await fetch(url("/notes"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(`POST /notes failed: ${response.status}`);
  }
  const payload = (await response.json()) as { note: Note };
  return payload.note;
};
