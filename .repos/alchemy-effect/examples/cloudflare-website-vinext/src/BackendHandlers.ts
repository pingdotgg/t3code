import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { BackendApi, Note, NotesList } from "./BackendApi";
import { DB } from "./Bindings";

export const BackendHandlers = HttpApiBuilder.group(
  BackendApi,
  "Backend",
  Effect.fn(function* (handlers) {
    const db = yield* Cloudflare.D1.QueryDatabase(DB);

    return handlers
      .handle("listNotes", () =>
        db
          .prepare(
            "SELECT id, title, source, created_at FROM notes ORDER BY created_at DESC",
          )
          .all<{
            id: string;
            title: string;
            source: string;
            created_at: number;
          }>()
          .pipe(
            Effect.map(
              ({ results }) =>
                new NotesList({
                  notes: (results ?? []).map(
                    (row) =>
                      new Note({
                        id: row.id,
                        title: row.title,
                        source: row.source,
                        createdAt: row.created_at,
                      }),
                  ),
                }),
            ),
            Effect.orDie,
          ),
      )
      .handle("createNote", ({ payload }) =>
        Effect.gen(function* () {
          const note = new Note({
            id: crypto.randomUUID(),
            title: payload.title,
            source: "effect-httpapi",
            createdAt: Date.now(),
          });
          yield* db
            .prepare(
              "INSERT INTO notes (id, title, source, created_at) VALUES (?, ?, ?, ?)",
            )
            .bind(note.id, note.title, note.source, note.createdAt)
            .run();
          return note;
        }).pipe(Effect.orDie),
      )
      .handle("deleteNote", ({ params }) =>
        db
          .prepare("DELETE FROM notes WHERE id = ?")
          .bind(params.id)
          .run()
          .pipe(Effect.asVoid, Effect.orDie),
      );
  }),
);
