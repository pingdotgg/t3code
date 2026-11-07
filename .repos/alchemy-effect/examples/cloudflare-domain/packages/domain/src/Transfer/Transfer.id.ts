import * as Schema from "effect/Schema";

export const TransferId = Schema.String.pipe(Schema.brand("TransferId"));
export type TransferId = typeof TransferId.Type;
