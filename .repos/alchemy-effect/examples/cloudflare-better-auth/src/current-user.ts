import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
});

export class CurrentUser extends Context.Service<CurrentUser, typeof User.Type>()(
  "app/CurrentUser",
) {}
