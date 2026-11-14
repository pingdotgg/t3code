import type * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface Preview {
  title: string;
  fetchedAt: number;
}

export interface Link {
  code: string;
  url: string;
  createdAt: number;
  preview?: Preview;
}

/** A missing link. The schema makes it a typed 404 on the HTTP API as well. */
export class LinkNotFound extends Schema.TaggedError<LinkNotFound>()(
  "LinkNotFound",
  { code: Schema.String },
  { httpApiStatus: 404 },
) {}

export class LinkStoreError extends Data.TaggedError("LinkStoreError")<{
  cause: unknown;
}> {}

/** Where links live. The Worker only sees this contract; a Layer decides the storage. */
export class Links extends Context.Service<
  Links,
  {
    create(url: string): Effect.Effect<Link, LinkStoreError, Alchemy.RuntimeContext>;
    get(code: string): Effect.Effect<Link, LinkNotFound | LinkStoreError, Alchemy.RuntimeContext>;
    list(): Effect.Effect<Link[], LinkStoreError, Alchemy.RuntimeContext>;
    setPreview(
      code: string,
      preview: Preview,
    ): Effect.Effect<void, LinkNotFound | LinkStoreError, Alchemy.RuntimeContext>;
  }
>()("Links") {}

/** Short, URL-safe codes. */
export const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    "abcdefghijkmnpqrstuvwxyz23456789".charAt(b % 32),
  ).join("");
