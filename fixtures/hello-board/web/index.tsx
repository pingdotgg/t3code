import { Button, defineWebPlugin, Input, type PluginWebRpc } from "@t3tools/plugin-sdk-web";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";

interface Note {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
}

function isNote(value: unknown): value is Note {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "body" in value &&
    typeof value.body === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function parseNotes(value: unknown): ReadonlyArray<Note> {
  return Array.isArray(value) ? value.filter(isNote) : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Plugin RPC failed.";
}

const shellStyle = {
  minHeight: "100%",
  padding: "24px",
  color: "var(--foreground)",
  background: "var(--background)",
} satisfies CSSProperties;

const panelStyle = {
  display: "flex",
  maxWidth: "640px",
  flexDirection: "column",
  gap: "16px",
} satisfies CSSProperties;

const noteStyle = {
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "12px",
  background: "var(--card)",
} satisfies CSSProperties;

function HelloBoardNotes({ rpc }: { readonly rpc: PluginWebRpc }) {
  const [notes, setNotes] = useState<ReadonlyArray<Note>>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      setNotes(parseNotes(await rpc.call("listNotes")));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const addNote = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      await rpc.call("addNote", { body: trimmed });
      setBody("");
      setNotes(parseNotes(await rpc.call("listNotes")));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [body, rpc]);

  return (
    <main style={shellStyle}>
      <section style={panelStyle}>
        <header>
          <h1 style={{ fontSize: "20px", fontWeight: 650, margin: 0 }}>Hello Board</h1>
          <p style={{ color: "var(--muted-foreground)", fontSize: "13px", margin: "4px 0 0" }}>
            Fixture plugin notes stored in the local plugin database table.
          </p>
        </header>
        <form
          style={{ display: "flex", gap: "8px" }}
          onSubmit={(event) => {
            event.preventDefault();
            void addNote();
          }}
        >
          <Input
            nativeInput
            aria-label="Note"
            value={body}
            placeholder="Write a note"
            onChange={(event) => setBody(event.currentTarget.value)}
          />
          <Button type="submit" disabled={loading || body.trim().length === 0}>
            Add
          </Button>
        </form>
        {error ? (
          <div
            role="alert"
            style={{
              border: "1px solid var(--destructive)",
              borderRadius: "8px",
              color: "var(--destructive)",
              padding: "10px 12px",
            }}
          >
            {error}
          </div>
        ) : null}
        <div style={{ display: "grid", gap: "8px" }}>
          {notes.length === 0 ? (
            <p style={{ color: "var(--muted-foreground)", fontSize: "13px", margin: 0 }}>
              No notes yet.
            </p>
          ) : (
            notes.map((note) => (
              <article key={note.id} style={noteStyle}>
                <p style={{ margin: 0 }}>{note.body}</p>
                <time style={{ color: "var(--muted-foreground)", fontSize: "12px" }}>
                  {note.createdAt}
                </time>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

export default defineWebPlugin({
  register: (ctx) => {
    ctx.registerRoute({
      path: "notes",
      component: () => <HelloBoardNotes rpc={ctx.rpc} />,
    });
    ctx.registerSidebarSection({
      id: "hello-board",
      title: "Hello Board",
      render: ({ routeBasePath }) => (
        <a
          href={routeBasePath ? `${routeBasePath}/notes` : undefined}
          style={{
            color: "var(--foreground)",
            display: "block",
            fontSize: "13px",
            padding: "6px 8px",
            textDecoration: "none",
          }}
        >
          Notes
        </a>
      ),
    });
  },
});
