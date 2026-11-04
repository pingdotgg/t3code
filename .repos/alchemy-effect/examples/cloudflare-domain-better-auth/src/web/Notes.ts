import type * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { NotesApi } from "../NotesApi.api.ts";
import { UserId } from "../User.id.ts";
import { auth } from "./auth.ts";

// The services the app's commands and subscriptions use: the NotesApi client.
type Notes = Domain.Api.ClientKey<"NotesApi">;

const User = Schema.Struct({ userId: UserId, name: Schema.String });

/** Who better-auth says is signed in when the page loads, or `null`. */
export const Flags = Schema.Struct({ user: Schema.NullOr(User) });
export type Flags = typeof Flags.Type;

export const Model = Schema.Struct({
  user: Schema.NullOr(User),
  draft: Schema.String,
  notes: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

const Provider = Schema.Literals(["github", "google"]);

export const Message = defineMessageUnion({
  ClickedSignIn: { provider: Provider },
  ClickedSignOut: {},
  ChangedDraft: { text: Schema.String },
  SubmittedNote: {},
  Saved: {},
  Failed: { reason: Schema.String },
  GotNotes: { notes: Schema.Array(Schema.String) },
});
export type Message = typeof Message.Type;

/** Send the browser to GitHub or Google; better-auth brings it back to `/` signed in. */
export const SignIn = Command.define("SignIn", {
  args: { provider: Provider },
  messages: [Message.Failed],
  execute: ({ provider }) =>
    Effect.promise(() => auth.signIn.social({ provider, callbackURL: "/" })).pipe(
      Effect.map((result) => Message.Failed({ reason: result.error?.message ?? "Redirecting" })),
    ),
});

/** Clear better-auth's session, then start over signed out. */
export const SignOut = Command.define("SignOut", {
  args: {},
  messages: [Message.Failed],
  execute: () =>
    Effect.promise(() => auth.signOut()).pipe(
      Effect.flatMap(() => Effect.sync(() => location.reload())),
      Effect.as(Message.Failed({ reason: "Signing out" })),
    ),
});

/** Write a note in the user's notebook. The session cookie goes with the call. */
export const WriteNote = Command.define("WriteNote", {
  args: { userId: UserId, text: Schema.String },
  messages: [Message.Saved, Message.Failed],
  execute: ({ userId, text }) =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.Client;
      yield* notes.WriteNote(userId, { text });
      return Message.Saved();
    }).pipe(Effect.catch((error) => Effect.succeed(Message.Failed({ reason: error._tag })))),
});

export const update = (model: Model, message: Message): Update.Return<Model, Message, Notes> =>
  Message.match<Update.Return<Model, Message, Notes>>(message, {
    ClickedSignIn: ({ provider }) => ({ model, commands: [SignIn({ provider })] }),
    ClickedSignOut: () => ({ model, commands: [SignOut({})] }),
    ChangedDraft: ({ text }) => ({ model: { ...model, draft: text } }),
    SubmittedNote: () =>
      model.user === null || model.draft.trim() === ""
        ? { model }
        : {
            model: { ...model, draft: "" },
            commands: [WriteNote({ userId: model.user.userId, text: model.draft })],
          },
    // The note arrives through the subscription; success only clears an error.
    Saved: () => ({ model: { ...model, error: null } }),
    Failed: ({ reason }) => ({ model: { ...model, error: reason } }),
    GotNotes: ({ notes }) => ({ model: { ...model, notes } }),
  });

export const init = (flags: Flags): Update.Return<Model, Message, Notes> => ({
  model: { user: flags.user, draft: "", notes: [], error: null },
});

export const subscriptions = Subscription.make<Model, Message, Notes>()((entry) => ({
  notes: entry(
    { userId: Schema.NullOr(UserId) },
    {
      modelToDependencies: (model) => ({ userId: model.user?.userId ?? null }),
      dependenciesToStream: ({ userId }) =>
        userId === null
          ? Stream.empty
          : Stream.unwrap(
              Effect.gen(function* () {
                const notes = yield* NotesApi.Client;
                return notes.Notes.watch(userId);
              }),
            ).pipe(
              Stream.map(({ state }) => Message.GotNotes({ notes: state?.notes ?? [] })),
              Stream.catch((error) => Stream.succeed(Message.Failed({ reason: error._tag }))),
            ),
    },
  ),
}));

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Notes",
  body:
    model.user === null
      ? h.div(
          [],
          [
            h.h1([], ["Notes"]),
            h.button(
              [h.OnClick(Message.ClickedSignIn({ provider: "github" }))],
              ["Sign in with GitHub"],
            ),
            h.button(
              [h.OnClick(Message.ClickedSignIn({ provider: "google" }))],
              ["Sign in with Google"],
            ),
            h.p([], [model.error ?? ""]),
          ],
        )
      : h.div(
          [],
          [
            h.h1([], ["Notes"]),
            h.p([], [`Signed in as ${model.user.name}`]),
            h.form(
              [h.OnSubmit(Message.SubmittedNote())],
              [
                h.input([
                  h.Value(model.draft),
                  h.Placeholder("Write a note"),
                  h.OnInput((text) => Message.ChangedDraft({ text })),
                ]),
                h.button([h.Type("submit")], ["Save"]),
              ],
            ),
            h.ul(
              [],
              model.notes.map((note) => h.li([], [note])),
            ),
            h.button([h.OnClick(Message.ClickedSignOut())], ["Sign out"]),
            h.p([], [model.error ?? ""]),
          ],
        ),
});
