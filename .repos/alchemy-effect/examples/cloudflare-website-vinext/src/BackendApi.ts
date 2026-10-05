import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

export class Note extends Schema.Class<Note>("Note")({
  id: Schema.String,
  title: Schema.String,
  source: Schema.String,
  createdAt: Schema.Number,
}) {}

export class NotesList extends Schema.Class<NotesList>("NotesList")({
  notes: Schema.Array(Note),
}) {}

export const listNotes = HttpApiEndpoint.get("listNotes", "/notes", {
  success: NotesList,
});

export const createNote = HttpApiEndpoint.post("createNote", "/notes", {
  success: Note.pipe(HttpApiSchema.status(201)),
  payload: Schema.Struct({
    title: Schema.String,
  }),
});

export const deleteNote = HttpApiEndpoint.delete("deleteNote", "/notes/:id", {
  params: Schema.Struct({
    id: Schema.String,
  }),
  success: HttpApiSchema.NoContent,
});

export class BackendGroup extends HttpApiGroup.make("Backend").add(
  listNotes,
  createNote,
  deleteNote,
) {}

/** Backend Worker HttpApi — D1 only. KV lives on the vinext frontend. */
export class BackendApi extends HttpApi.make("BackendApi").add(BackendGroup) {}
