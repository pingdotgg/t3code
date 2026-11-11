import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { defaultStage } from "@alchemy.run/test/Core";
import * as Turso from "@alchemy.run/turso";
import { organization } from "@alchemy.run/turso/Credentials";
import * as Hrana from "@alchemy.run/turso/Hrana";
import * as turso from "@distilled.cloud/turso/turso";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

// The Preview databases guide, with per-developer stage names: `<stage>-staging`
// owns the group and database, `<stage>-pr` forks staging's database.
const { test, deploy, destroy } = Test.make({
  providers: Turso.providers(),
  state: Alchemy.localState(),
});

const staging = `${defaultStage()}-staging`;
const pr = `${defaultStage()}-pr`;

const Stack = Alchemy.Stack(
  "TursoPreviewDatabases",
  { providers: Turso.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const preview = stage === pr;

    const group = preview
      ? yield* Turso.Group.ref("Group", { stage: staging })
      : yield* Turso.Group("Group", { location: "aws-us-east-1" });

    const source = preview ? yield* Turso.Database.ref("Db", { stage: staging }) : undefined;

    const db = yield* Turso.Database("Db", {
      group: group.name,
      seed: source ? { type: "database", name: source.name } : undefined,
    });
    return { db, group: group.name };
  }),
);

const sql = (database: string, hostname: string, statement: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    const { jwt } = yield* turso.createDatabaseToken({
      organizationSlug: org,
      databaseName: database,
      expiration: "5m",
    });
    return yield* Hrana.query({ url: `https://${hostname}`, authToken: jwt! }, statement);
  });

const exists = (database: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    return yield* turso.getDatabase({ organizationSlug: org, databaseName: database }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
    );
  });

test.provider(
  "a preview stage forks staging's database and is destroyed alone",
  () =>
    Effect.gen(function* () {
      yield* destroy(Stack, { stage: pr });
      yield* destroy(Stack, { stage: staging });

      const stagingOut = yield* deploy(Stack, { stage: staging });
      yield* sql(stagingOut.db.name, stagingOut.db.hostname, "CREATE TABLE t (v INTEGER)");
      yield* sql(stagingOut.db.name, stagingOut.db.hostname, "INSERT INTO t VALUES (42)");

      const prOut = yield* deploy(Stack, { stage: pr });
      expect(prOut.group).toBe(stagingOut.group);
      expect(prOut.db.name).not.toBe(stagingOut.db.name);
      expect(yield* sql(prOut.db.name, prOut.db.hostname, "SELECT v FROM t")).toEqual([{ v: 42 }]);

      // Destroying the preview deletes only its fork.
      yield* destroy(Stack, { stage: pr });
      expect(yield* exists(prOut.db.name)).toBe(false);
      expect(yield* exists(stagingOut.db.name)).toBe(true);

      yield* destroy(Stack, { stage: staging });
      expect(yield* exists(stagingOut.db.name)).toBe(false);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 240_000 },
);
