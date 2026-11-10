import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentUser } from "./CurrentUser.context.ts";
import { Notebook } from "./Notebook.aggregate.ts";
import { NotYours } from "./NotYours.rejection.ts";
import { Session } from "./Session.middleware.ts";

/** The notes in a notebook. Only its owner may read them. */
export class Notes extends Domain.View("Notes", {
  from: [Notebook],
  key: Notebook,
  middleware: [Session],
  rejects: [NotYours],
  state: Schema.Struct({ notes: Schema.Array(Schema.String) }),
  initial: { notes: [] },
  evolve: {
    NoteWritten: (v, e) => ({ notes: [...v.notes, e.text] }),
  },
  validate: Effect.fn(function* (request) {
    const user = yield* CurrentUser;
    if (request.key.id !== user.userId) return yield* new NotYours();
  }),
}) {}
