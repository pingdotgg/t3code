import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** The account is frozen. */
export class Frozen extends Domain.Rejection("Frozen", { reason: Schema.String }) {}
