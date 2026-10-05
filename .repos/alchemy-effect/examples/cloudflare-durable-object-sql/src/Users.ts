import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle/Cloudflare";
import * as Effect from "effect/Effect";
import { relations, users } from "./schema.ts";

export default class Users extends Cloudflare.DurableObject<Users>()(
  "Users",
  Effect.gen(function* () {
    const migrations = yield* Cloudflare.SqlMigrations("./drizzle");

    return Effect.gen(function* () {
      const db = yield* Drizzle.DurableObject({ migrations, relations });

      return {
        addUser: (name: string) =>
          db.insert(users).values({ name }).returning(),
        listUsers: () => db.select().from(users).orderBy(users.id),
      };
    });
  }),
) {}
