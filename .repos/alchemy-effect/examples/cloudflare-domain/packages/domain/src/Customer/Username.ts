import * as Schema from "effect/Schema";

/** A customer's unique handle. */
export const Username = Schema.String.pipe(Schema.brand("Username"));
export type Username = typeof Username.Type;
