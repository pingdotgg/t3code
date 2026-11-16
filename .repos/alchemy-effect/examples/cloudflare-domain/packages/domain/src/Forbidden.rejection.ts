import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** The caller may not read or do this. */
export class Forbidden extends Domain.Rejection("Forbidden", { reason: Schema.String }) {}
