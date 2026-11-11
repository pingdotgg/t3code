import * as Schema from "effect/Schema";

export const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));
export type CustomerId = typeof CustomerId.Type;
