import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle/Cloudflare.ts";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
// The exact artifacts `drizzle-kit generate` emits for
// `driver: "durable-sqlite"` — a `migrations.js` that imports each
// migration's `.sql` file as a text module. Bare `.sql` imports resolve
// via the bundler's default text module types (see Bundle.ts), the same
// way Wrangler's `Text` rules handle them.
import migrations from "./drizzle/migrations.js";
import { posts, relations, users } from "./schema.ts";

export class DrizzleUsersObject extends Cloudflare.DurableObject<DrizzleUsersObject>()(
  "DrizzleUsersObject",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      // Opens drizzle over this instance's SQLite storage — with the
      // relational schema — and applies the generated migrations before
      // any request touches the db.
      const db = yield* Drizzle.DurableObject({ migrations, relations });

      return {
        addUser: (name: string) =>
          db
            .insert(users)
            .values({ name })
            .returning()
            .pipe(Effect.map((rows) => rows[0]!.id)),
        addPost: (userId: number, title: string) =>
          db.insert(posts).values({ userId, title }).pipe(Effect.asVoid),
        listUsers: () =>
          db
            .select()
            .from(users)
            .pipe(Effect.map((rows) => rows.map((row) => row.name))),
        // Relational query through the `relations` config — proves the
        // schema/relationships flow through Drizzle.DurableObject's types.
        listUsersWithPosts: () =>
          db.query.users.findMany({ with: { posts: true } }).pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                name: row.name,
                posts: row.posts.map((post) => post.title),
              })),
            ),
          ),
        // A deliberately failing query, recovered with a typed catch —
        // proves per-operation errors are tagged and catchable.
        queryMissingTable: () =>
          Effect.gen(function* () {
            return yield* db.run(sql`SELECT * FROM missing_table`).pipe(
              Effect.as("unexpected success"),
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                Effect.succeed(`caught:${error._tag}`),
              ),
            );
          }),
      };
    });
  }),
) {}
