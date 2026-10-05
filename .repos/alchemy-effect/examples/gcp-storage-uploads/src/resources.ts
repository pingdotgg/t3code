import * as GCP from "alchemy/GCP";

/** Only objects under this prefix trigger the indexer. */
export const UPLOADS_PREFIX = "uploads/";

/**
 * Where the uploaded bytes live. `forceDestroy` empties the bucket on
 * `alchemy destroy`; drop it in production so a destroy cannot take user
 * data with it.
 */
export const Uploads = GCP.Storage.Bucket("Uploads", {
  forceDestroy: true,
});

/**
 * One Firestore document per file, at `files/{name}`, written by the
 * indexer once the object has landed.
 */
export const Files = GCP.Firestore.Database("Files", {
  type: "FIRESTORE_NATIVE",
});

/**
 * File names double as Firestore document ids and object-name suffixes,
 * so keep them to a URL- and id-safe alphabet.
 */
export const isValidName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);

export const objectFor = (name: string) => `${UPLOADS_PREFIX}${name}`;

export const documentFor = (name: string) => `files/${name}`;

/** What the indexer records for each upload. */
export interface FileRecord {
  name: string;
  object: string;
  generation: string;
  size: number;
  contentType: string;
  sha256: string;
  indexedAt: Date;
}
