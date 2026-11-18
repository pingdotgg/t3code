import * as Schema from "effect/Schema";

export const Link = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
});
export type Link = typeof Link.Type;

/** A missing link: a typed error in code and a typed 404 over HTTP. */
export class LinkNotFound extends Schema.TaggedError<LinkNotFound>()(
  "LinkNotFound",
  { code: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Short, URL-safe codes. */
export const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    "abcdefghijkmnpqrstuvwxyz23456789".charAt(b % 32),
  ).join("");
