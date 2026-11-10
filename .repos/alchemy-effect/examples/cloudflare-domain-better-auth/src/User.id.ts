import * as Schema from "effect/Schema";

/** A user's id, as better-auth assigns it. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
