import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NotYours } from "./NotYours.rejection.ts";
import { Session } from "./Session.middleware.ts";
import { UserId } from "./User.id.ts";

export class NoteWritten extends Domain.Event("NoteWritten", {
  text: Schema.String,
  author: Schema.String,
}) {}

/** Write a note in your own notebook. */
export class WriteNote extends Domain.Command("WriteNote", {
  target: UserId,
  middleware: [Session],
  input: { text: Schema.NonEmptyString },
  events: [NoteWritten],
  rejects: [NotYours],
}) {}
