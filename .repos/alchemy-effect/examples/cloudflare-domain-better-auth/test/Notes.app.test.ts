import { expect, test } from "@effect/vitest";
import * as Story from "foldkit/story";
import { UserId } from "../src/User.id.ts";
import { Message, type Model, SignIn, update, WriteNote } from "../src/web/Notes.ts";

const signedOut: Model = { user: null, draft: "", notes: [], error: null };
const sam: Model = {
  user: { userId: UserId.make("u-sam"), name: "Sam" },
  draft: "",
  notes: [],
  error: null,
};

test("signing in sends the browser to the chosen provider", () =>
  Story.story(
    update,
    Story.given(signedOut),
    Story.message(Message.ClickedSignIn({ provider: "github" })),
    Story.Command.resolve(SignIn, Message.Failed({ reason: "Redirecting" })),
    Story.model((next) => expect(next.user).toBeNull()),
  ));

test("a note is written to the user's notebook, and arrives from the watch", () =>
  Story.story(
    update,
    Story.given(sam),
    Story.message(Message.ChangedDraft({ text: "buy milk" })),
    Story.message(Message.SubmittedNote()),
    Story.Command.resolve(WriteNote, Message.Saved()),
    Story.model((next) => {
      expect(next.draft).toBe("");
      expect(next.notes).toEqual([]);
    }),
    Story.message(Message.GotNotes({ notes: ["buy milk"] })),
    Story.model((next) => expect(next.notes).toEqual(["buy milk"])),
  ));
