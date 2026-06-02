import { Schema } from "effect"

export const UserId = Schema.Int.pipe(
  Schema.brand("UserId")
)
export type UserId = typeof UserId.Type

export class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String
}) {}
