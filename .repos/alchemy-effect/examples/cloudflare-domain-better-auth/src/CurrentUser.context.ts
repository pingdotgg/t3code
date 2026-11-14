import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { UserId } from "./User.id.ts";

/** The signed-in user behind a request. */
export class CurrentUser extends Domain.RequestContext<CurrentUser>()(
  "Notes/CurrentUser",
  Schema.Struct({ userId: UserId, name: Schema.String }),
) {}
