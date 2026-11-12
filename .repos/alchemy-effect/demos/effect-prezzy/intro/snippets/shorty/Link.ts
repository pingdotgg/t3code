import * as Schema from "effect/Schema";

// #region show
export const Link = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  // #region createdAt
  createdAt: Schema.String,
  // #endregion createdAt
});
export type Link = typeof Link.Type;
// #region notFound

export class LinkNotFound extends Schema.TaggedError<LinkNotFound>()(
  "LinkNotFound",
  { code: Schema.String },
  // #region status
  { httpApiStatus: 404 },
  // #endregion status
) {}
// #endregion notFound
// #endregion show

/** Short, URL-safe codes. */
export const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    "abcdefghijkmnpqrstuvwxyz23456789".charAt(b % 32),
  ).join("");
