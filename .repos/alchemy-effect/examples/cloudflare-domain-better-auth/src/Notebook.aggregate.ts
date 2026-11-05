import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentUser } from "./CurrentUser.context.ts";
import { NotYours } from "./NotYours.rejection.ts";
import { UserId } from "./User.id.ts";
import { NoteWritten, WriteNote } from "./WriteNote.command.ts";

/** Each user's notebook, keyed by their id. */
export class Notebook extends Domain.Aggregate("Notebook", {
  id: UserId,
  state: Schema.Struct({ notes: Schema.Int }),
  initial: { notes: 0 },
  commands: [WriteNote],
  decide: {
    WriteNote: Effect.fn(function* (_s, cmd, { id }) {
      const user = yield* CurrentUser;
      if (user.userId !== id) return yield* new NotYours();
      return [new NoteWritten({ text: cmd.text, author: user.name })];
    }),
  },
  evolve: {
    NoteWritten: (s) => ({ notes: s.notes + 1 }),
  },
}) {}
