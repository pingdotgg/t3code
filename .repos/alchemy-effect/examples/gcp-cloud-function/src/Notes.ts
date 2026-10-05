import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { NotesDb } from "./resources.ts";

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

const toNote = (snapshot: {
  name: string;
  fields: Record<string, unknown>;
}): Note => ({
  id: snapshot.name.split("/").pop()!,
  title: String(snapshot.fields.title ?? ""),
  body: String(snapshot.fields.body ?? ""),
  createdAt:
    snapshot.fields.createdAt instanceof Date
      ? snapshot.fields.createdAt.toISOString()
      : String(snapshot.fields.createdAt ?? ""),
});

const notFound = () =>
  HttpServerResponse.json({ error: "not found" }, { status: 404 });

/**
 * A notes API on a 2nd-gen Cloud Function.
 *
 * Alchemy bundles this module for Node.js 22, uploads it, and serves
 * `fetch` through the Functions Framework — no Dockerfile and no local
 * image build. `GCP.Firestore.ReadWriteDatabase` grants the function's
 * runtime service account `roles/datastore.user` and hands back a client
 * that speaks plain JavaScript objects.
 *
 * - `POST /notes` — create a note from `{ title, body }`.
 * - `GET /notes` — list notes.
 * - `GET /notes/:id` — read one note.
 * - `DELETE /notes/:id` — delete a note.
 */
export default class Notes extends GCP.CloudFunctions.Function<Notes>()(
  "Notes",
  { main: import.meta.url },
  Effect.gen(function* () {
    const db = yield* GCP.Firestore.ReadWriteDatabase(NotesDb);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.url, "http://localhost");
        const [collection, id, ...rest] = pathname.split("/").filter(Boolean);

        if (collection !== "notes" || rest.length > 0) return yield* notFound();

        if (id === undefined && request.method === "POST") {
          const input = (yield* request.json) as {
            title?: unknown;
            body?: unknown;
          };
          if (typeof input.title !== "string" || input.title === "") {
            return yield* HttpServerResponse.json(
              { error: "title is required" },
              { status: 400 },
            );
          }
          const snapshot = yield* db.create(`notes/${crypto.randomUUID()}`, {
            title: input.title,
            body: typeof input.body === "string" ? input.body : "",
            createdAt: new Date(),
          });
          return yield* HttpServerResponse.json(toNote(snapshot), {
            status: 201,
          });
        }

        if (id === undefined && request.method === "GET") {
          const { documents } = yield* db.list("notes", { pageSize: 100 });
          return yield* HttpServerResponse.json({
            notes: documents.map(toNote),
          });
        }

        if (id !== undefined && request.method === "GET") {
          const snapshot = yield* db.get(`notes/${id}`);
          if (snapshot === undefined) return yield* notFound();
          return yield* HttpServerResponse.json(toNote(snapshot));
        }

        if (id !== undefined && request.method === "DELETE") {
          yield* db.delete(`notes/${id}`);
          return HttpServerResponse.empty({ status: 204 });
        }

        return yield* HttpServerResponse.json(
          { error: "method not allowed" },
          { status: 405 },
        );
      }).pipe(
        // Surface Firestore failures (e.g. IAM still propagating right after
        // a deploy) as a 500 with the error tag instead of an opaque crash.
        Effect.catch((error) =>
          HttpServerResponse.json({ error: error._tag }, { status: 500 }).pipe(
            Effect.orDie,
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp)),
) {}
