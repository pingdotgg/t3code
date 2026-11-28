import { createClerkClient } from "@clerk/backend";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// Clerk's largest page.
const PAGE_SIZE = 500;

class ClerkListFailed extends Schema.TaggedError<ClerkListFailed>()("ClerkListFailed", {
  cause: Schema.Defect(),
}) {}

const encodeRows = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ user_id: Schema.String, email: Schema.String })),
  ),
);

// Fills relay_account_emails for accounts created before the Clerk webhook was subscribed to
// user.created and user.updated. Safe to rerun: rows the webhook already wrote are left alone,
// and accounts with a recorded deletion are skipped.
const main = Effect.gen(function* () {
  const dryRun = process.argv.includes("--dry-run");
  const secretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
  const clerk = createClerkClient({ secretKey: Redacted.value(secretKey) });
  const sql = yield* PgClient.PgClient;

  let startingAfter: string | undefined;
  let seen = 0;
  let withoutEmail = 0;
  let inserted = 0;
  for (;;) {
    const cursor = startingAfter;
    const page = yield* Effect.tryPromise({
      try: () =>
        clerk.users.getUserListWithoutCount({
          limit: PAGE_SIZE,
          // Oldest first, so accounts created during the run land on later pages.
          orderBy: "+created_at",
          ...(cursor === undefined ? {} : { startingAfter: cursor }),
        }),
      catch: (cause) => new ClerkListFailed({ cause }),
    });
    const users = page.data;
    seen += users.length;
    const rows = users.flatMap((user) => {
      const email = user.primaryEmailAddress?.emailAddress;
      if (email === undefined) {
        withoutEmail += 1;
        return [];
      }
      return [{ user_id: user.id, email }];
    });
    if (!dryRun && rows.length > 0) {
      const payload = yield* encodeRows(rows);
      const written = yield* sql<{ user_id: string }>`
        insert into relay_account_emails (user_id, email)
        select t.user_id, t.email
        from json_to_recordset(${payload}::json) as t(user_id text, email text)
        where not exists (
          select 1 from relay_account_deletions d where d.user_id = t.user_id
        )
        on conflict (user_id) do nothing
        returning user_id
      `;
      inserted += written.length;
    }
    yield* Console.log(`${seen} users read, ${inserted} emails written`);
    if (users.length < PAGE_SIZE) break;
    startingAfter = users.at(-1)?.id;
  }
  yield* Console.log(
    `Done${dryRun ? " (dry run, nothing written)" : ""}: ${seen} users, ${withoutEmail} without a primary email, ${inserted} emails written.`,
  );
});

const Database = Layer.unwrap(
  Effect.map(Config.Redacted("DATABASE_URL"), (url) => PgClient.layer({ url })),
);

main.pipe(Effect.provide(Database), NodeRuntime.runMain);
