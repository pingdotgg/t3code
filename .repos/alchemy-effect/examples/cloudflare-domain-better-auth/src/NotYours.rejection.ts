import * as Domain from "@alchemy.run/domain";

/** The notebook belongs to someone else. */
export class NotYours extends Domain.Rejection("NotYours") {}
