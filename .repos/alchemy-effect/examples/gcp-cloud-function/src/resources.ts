import * as GCP from "alchemy/GCP";

/**
 * One Firestore document per note, at `notes/{id}`. The project's
 * `(default)` database may be Datastore-mode, so the example brings its own
 * named Native-mode database.
 */
export const NotesDb = GCP.Firestore.Database("NotesDb", {
  type: "FIRESTORE_NATIVE",
});
