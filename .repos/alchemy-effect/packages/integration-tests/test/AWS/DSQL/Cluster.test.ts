import * as AWS from "@alchemy.run/aws";
import { Cluster, ClusterPolicy } from "@alchemy.run/aws/DSQL";
// Internal to alchemy, so not exported.
import { withDsqlClient } from "@alchemy.run/aws/DSQL/Migrations";
import * as Drizzle from "@alchemy.run/drizzle";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dsql from "@distilled.cloud/aws/dsql";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Drizzle.providers()),
});

/** Docs-canonical policy: deny non-VPC connections. */
const vpcOnlyPolicy = (exceptions?: string[]) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyNonVpcConnect",
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: ["dsql:DbConnect", "dsql:DbConnectAdmin"],
        Resource: "*",
        Condition: {
          Null: { "aws:SourceVpc": "true" },
          ...(exceptions ? { StringNotEquals: { "aws:PrincipalArn": exceptions } } : {}),
        },
      },
    ],
  });

const getCluster = (identifier: string) =>
  dsql
    .getCluster({ identifier })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));

test.provider(
  "create, update deletion protection, delete DSQL cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create (deletion protection off for test economics)
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            tags: { app: "alchemy-test" },
          });
        }),
      );

      expect(created.clusterId).toBeDefined();
      expect(created.clusterArn).toContain(`:cluster/${created.clusterId}`);
      expect(["ACTIVE", "IDLE"]).toContain(created.status);
      expect(created.endpoint).toContain(created.clusterId);
      expect(created.deletionProtectionEnabled).toBe(false);

      // out-of-band verification
      const observed = yield* getCluster(created.clusterId);
      expect(observed?.identifier).toEqual(created.clusterId);
      expect(observed?.deletionProtectionEnabled).toBe(false);

      // update: enable deletion protection
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
        }),
      );
      expect(updated.clusterId).toEqual(created.clusterId);
      const reobserved = yield* getCluster(created.clusterId);
      expect(reobserved?.deletionProtectionEnabled).toBe(true);

      // attach a resource-based cluster policy (singleton sub-resource)
      const withPolicy = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
          const policy = yield* ClusterPolicy("AppDbPolicy", {
            clusterId: cluster.clusterId,
            policy: vpcOnlyPolicy(),
          });
          return {
            clusterId: cluster.clusterId,
            policyVersion: policy.policyVersion,
          };
        }),
      );
      expect(withPolicy.clusterId).toEqual(created.clusterId);
      expect(withPolicy.policyVersion).toBeDefined();

      // out-of-band verification of the attached document
      const attached = yield* dsql.getClusterPolicy({
        identifier: created.clusterId,
      });
      expect(attached.policy).toContain("DenyNonVpcConnect");
      expect(attached.policyVersion).toEqual(withPolicy.policyVersion);

      // update the policy document in place (version bumps)
      const policyUpdated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
          const policy = yield* ClusterPolicy("AppDbPolicy", {
            clusterId: cluster.clusterId,
            policy: vpcOnlyPolicy(["arn:aws:iam::123456789012:role/ExceptionRole"]),
          });
          return { policyVersion: policy.policyVersion };
        }),
      );
      expect(policyUpdated.policyVersion).not.toEqual(withPolicy.policyVersion);
      const reattached = yield* dsql.getClusterPolicy({
        identifier: created.clusterId,
      });
      expect(reattached.policy).toContain("ExceptionRole");

      // delete (provider disables deletion protection automatically)
      yield* stack.destroy();
      const gone = yield* getCluster(created.clusterId);
      // A deleted DSQL cluster is either gone or reports DELETING/DELETED.
      expect(gone === undefined || gone.status === "DELETING" || gone.status === "DELETED").toBe(
        true,
      );
    }),
  { tags: ["provider:aws", "provider:aws:dsql", "live"], timeout: 300_000 },
);

test.provider(
  "applies Drizzle migrations on deploy, applies new ones in place, and rejects edited history",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Generate into a temp directory so the test never writes checked-in files.
      const out = yield* fs.makeTempDirectoryScoped();
      const schema = path.join(import.meta.dirname, "fixtures/migrations/schema.ts");
      const deploy = Effect.gen(function* () {
        const generated = yield* Drizzle.Schema("Schema", { schema, out, dialect: "postgres" });
        return yield* Cluster("Database", { migrations: generated.out });
      });
      const query = (endpoint: string, sql: string) =>
        withDsqlClient(endpoint, (client) => Effect.tryPromise(() => client.query(sql)));

      const created = yield* stack.deploy(deploy);
      const history = yield* query(created.endpoint, "SELECT name, hash FROM __alchemy_migrations");
      expect(history.rows).toHaveLength(1);
      // CREATE INDEX ran as CREATE INDEX ASYNC and was awaited.
      const indexes = yield* query(
        created.endpoint,
        "SELECT indisvalid FROM pg_index WHERE indexrelid = 'users_email_idx'::regclass",
      );
      expect(indexes.rows[0].indisvalid).toBe(true);
      yield* query(
        created.endpoint,
        "INSERT INTO users(id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'test@example.com')",
      );

      // A new migration file at the same path updates the cluster in place
      // and keeps existing rows.
      const [first] = (yield* fs.readDirectory(out)).sort();
      const next = path.join(out, "20990101000000_evolve");
      yield* fs.makeDirectory(next);
      yield* fs.writeFileString(
        path.join(next, "migration.sql"),
        `ALTER TABLE users ADD COLUMN nickname text;
ALTER TABLE users RENAME COLUMN email TO address;`,
      );
      const updated = yield* stack.deploy(deploy);
      expect(updated.clusterId).toBe(created.clusterId);
      const user = yield* query(updated.endpoint, "SELECT address, nickname FROM users");
      expect(user.rows).toEqual([{ address: "test@example.com", nickname: null }]);
      const after = yield* query(updated.endpoint, "SELECT name FROM __alchemy_migrations");
      expect(after.rows).toHaveLength(2);

      // Editing an applied migration fails the deploy instead of silently
      // skipping it.
      yield* fs.writeFileString(
        path.join(out, first!, "migration.sql"),
        "CREATE TABLE users (id uuid PRIMARY KEY);",
      );
      const failure = yield* stack.deploy(deploy).pipe(Effect.flip);
      expect(String(failure)).toMatch(/changed|does not match/i);

      yield* stack.destroy();
      const gone = yield* getCluster(created.clusterId);
      expect(gone === undefined || gone.status === "DELETING" || gone.status === "DELETED").toBe(
        true,
      );
    }),
  { tags: ["provider:aws", "provider:aws:dsql", "live"], timeout: 600_000 },
);
