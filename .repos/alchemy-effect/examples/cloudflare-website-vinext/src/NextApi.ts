import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";
import { Note, NotesList } from "./BackendApi";

export class Hello extends Schema.Class<Hello>("Hello")({
  message: Schema.String,
  noteCount: Schema.Number,
}) {}

export class KvValue extends Schema.Class<KvValue>("KvValue")({
  value: Schema.NullOr(Schema.String),
}) {}

export class KvOk extends Schema.Class<KvOk>("KvOk")({
  ok: Schema.Boolean,
}) {}

export class FrontendApi extends HttpApi.make("FrontendApi")
  .add(
    HttpApiGroup.make("frontend", { topLevel: true }).add(
      HttpApiEndpoint.get("hello", "/hello", {
        success: Hello,
      }),
      HttpApiEndpoint.get("listNotes", "/notes", {
        success: NotesList,
      }),
      HttpApiEndpoint.post("createNote", "/notes", {
        payload: Schema.Struct({
          title: Schema.String,
        }),
        success: Note.pipe(HttpApiSchema.status(201)),
      }),
      HttpApiEndpoint.delete("deleteNote", "/notes/:id", {
        params: Schema.Struct({
          id: Schema.String,
        }),
        success: HttpApiSchema.NoContent,
      }),
      HttpApiEndpoint.get("getKv", "/kv/:key", {
        params: Schema.Struct({
          key: Schema.String,
        }),
        success: KvValue,
      }),
      HttpApiEndpoint.put("putKv", "/kv/:key", {
        params: Schema.Struct({
          key: Schema.String,
        }),
        payload: Schema.String.pipe(HttpApiSchema.asText()),
        success: KvOk.pipe(HttpApiSchema.status(201)),
      }),
    ),
  )
  .prefix("/api") {}
