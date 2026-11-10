import * as Domain from "@alchemy.run/domain";

/** The actor does not own the account. */
export class NotOwner extends Domain.Rejection("NotOwner") {}
