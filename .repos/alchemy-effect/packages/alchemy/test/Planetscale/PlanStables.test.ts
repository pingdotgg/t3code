import * as Plan from "@/Plan";
import * as Planetscale from "@/Planetscale";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import {
  InMemoryService,
  inMemoryState,
  State,
  type ResourceState,
} from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const TEST_STACK = "planetscale-plan-stables";
const TEST_STAGE = "test";

// Fresh in-memory state per test run so seeded resources from one test
// don't leak into another in the same file.
const freshState = Layer.effect(
  State,
  Effect.sync(() => InMemoryService({})),
);

const { test } = Test.make({
  providers: Planetscale.providers(),
  state: freshState,
});

const seed = (resources: Record<string, ResourceState>) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    for (const [fqn, value] of Object.entries(resources)) {
      yield* state.set({ stack: TEST_STACK, stage: TEST_STAGE, fqn, value });
    }
  });

const instanceId = "852f6ec2e19b66589825efe14dca2971";

const makePlan = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  // @ts-expect-error - Stack.make's typing erases R unsoundly here
  Effect.gen(function* () {
    // @ts-expect-error
    return yield* effect.pipe(
      // @ts-expect-error
      Stack.make({
        name: TEST_STACK,
        providers: Layer.empty,
        state: inMemoryState(),
      }),
      Effect.provideService(Stage, TEST_STAGE),
      Effect.flatMap((stackSpec: any) => Plan.make(stackSpec)),
      Effect.provide(Planetscale.providers()),
    );
  });

const ORG = "test-org";
const DB_NAME = "relay-db";
const BRANCH_NAME = "relay-branch";
const ROLE_NAME = "relay-role";

/** Attributes of the database as persisted after a previous deploy. */
const databaseAttrs = (migrationsHashes: Record<string, string>) => ({
  id: "db_123",
  name: DB_NAME,
  organization: ORG,
  state: "ready",
  defaultBranch: "main",
  plan: "scaler",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  htmlUrl: `https://app.planetscale.com/${ORG}/${DB_NAME}`,
  region: { slug: "us-east" },
  migrationsDir: "./migrations",
  migrationsTable: "relay_migrations",
  migrationsHashes,
  importHashes: {},
  clusterSize: "PS_10",
  arch: "x86" as const,
  requireApprovalForDeploy: false,
  restrictBranchRegion: false,
  productionBranchWebConsole: false,
});

const branchAttrs = () => ({
  name: BRANCH_NAME,
  organization: ORG,
  database: DB_NAME,
  parentBranch: "main",
  production: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  htmlUrl: `https://app.planetscale.com/${ORG}/${DB_NAME}/${BRANCH_NAME}`,
  region: { slug: "us-east" },
  migrationsDir: undefined,
  migrationsTable: undefined,
  migrationsHashes: {},
  importHashes: {},
  desiredReplicas: undefined,
  hasReplicas: false,
  hasReadOnlyReplicas: false,
});

const roleAttrs = () => ({
  id: "role_123",
  name: ROLE_NAME,
  expiresAt: null,
  host: "gateway.psdb.cloud",
  username: ROLE_NAME,
  password: Redacted.make("secret"),
  database: DB_NAME,
  databaseName: "postgres",
  origin: {
    scheme: "postgres",
    host: "gateway.psdb.cloud",
    port: 5432,
    database: "postgres",
    user: ROLE_NAME,
    password: Redacted.make("secret"),
  },
  pooledOrigin: {
    scheme: "postgres",
    host: "gateway.psdb.cloud",
    port: 6432,
    database: "postgres",
    user: ROLE_NAME,
    password: Redacted.make("secret"),
  },
  connectionUrl: Redacted.make("postgresql://..."),
  connectionUrlPooled: Redacted.make("postgresql://..."),
  inheritedRoles: ["pg_read_all_data"],
  successor: "postgres",
  organization: ORG,
  branch: BRANCH_NAME,
  ttl: null,
});

const stateRow = (
  fqn: string,
  resourceType: string,
  props: Record<string, unknown>,
  attr: Record<string, unknown>,
): ResourceState => ({
  instanceId,
  providerVersion: 0,
  logicalId: fqn,
  fqn,
  namespace: undefined,
  resourceType,
  status: "created",
  props,
  attr,
  bindings: [],
  downstream: [],
});

describe("Planetscale plan-time name stables", () => {
  // Regression: a metadata-only update on a PostgresBranch (e.g. a
  // referenced database's `migrationsHashes` moved) must not strip
  // `branch.name` from downstream plan resolution — PostgresRole used to
  // compare the old branch name against `undefined` and falsely plan a
  // replacement (rotating credentials and crashing on the replacement's
  // reconcile with `branch: undefined`).
  test(
    "role updates (not replaces) when its branch gets a metadata-only update",
    Effect.gen(function* () {
      // The database is an external ref (another stack/stage); its attrs
      // arrive in props as a plain object. The previous deploy persisted
      // the old migration hash; the new plan resolves the new one.
      const oldDatabase = databaseAttrs({ "0001_init.sql": "aaa" });
      const newDatabase = databaseAttrs({
        "0001_init.sql": "aaa",
        "0002_add_table.sql": "bbb",
      });

      yield* seed({
        Branch: stateRow(
          "Branch",
          "Planetscale.PostgresBranch",
          { name: BRANCH_NAME, database: oldDatabase },
          branchAttrs(),
        ),
        Role: stateRow(
          "Role",
          "Planetscale.PostgresRole",
          {
            name: ROLE_NAME,
            database: oldDatabase,
            branch: branchAttrs(),
            inheritedRoles: ["pg_read_all_data"],
          },
          roleAttrs(),
        ),
      });

      const plan = yield* Effect.gen(function* () {
        const branch = yield* Planetscale.PostgresBranch("Branch", {
          name: BRANCH_NAME,
          database: newDatabase as unknown as Planetscale.PostgresDatabase,
        });
        yield* Planetscale.PostgresRole("Role", {
          name: ROLE_NAME,
          database: newDatabase as unknown as Planetscale.PostgresDatabase,
          branch,
          inheritedRoles: ["pg_read_all_data"],
        });
      }).pipe(makePlan);

      expect(plan.resources.Branch!.action).toBe("update");
      // The branch update is not a rename, so `branch.name` stays
      // resolvable and the role must not be replaced.
      expect(plan.resources.Role!.action).toBe("update");
    }),
  );

  // Regression: an in-place update on a PostgresDatabase (settings toggle,
  // new migration hash, …) must keep `database.name` resolvable — the
  // branch used to compare its persisted database name against `undefined`
  // and plan a replacement, cascading into the role.
  test(
    "branch and role update (not replace) when the database gets an in-place update",
    Effect.gen(function* () {
      const dbAttrs = databaseAttrs({});

      yield* seed({
        Db: stateRow(
          "Db",
          "Planetscale.PostgresDatabase",
          {
            name: DB_NAME,
            clusterSize: "PS_10",
            requireApprovalForDeploy: false,
          },
          dbAttrs,
        ),
        Branch: stateRow(
          "Branch",
          "Planetscale.PostgresBranch",
          { name: BRANCH_NAME, database: dbAttrs },
          branchAttrs(),
        ),
        Role: stateRow(
          "Role",
          "Planetscale.PostgresRole",
          {
            name: ROLE_NAME,
            database: dbAttrs,
            branch: branchAttrs(),
            inheritedRoles: ["pg_read_all_data"],
          },
          roleAttrs(),
        ),
      });

      const plan = yield* Effect.gen(function* () {
        const db = yield* Planetscale.PostgresDatabase("Db", {
          name: DB_NAME,
          clusterSize: "PS_10",
          // In-place settings change — triggers an update, not a rename.
          requireApprovalForDeploy: true,
        });
        const branch = yield* Planetscale.PostgresBranch("Branch", {
          name: BRANCH_NAME,
          database: db,
        });
        yield* Planetscale.PostgresRole("Role", {
          name: ROLE_NAME,
          database: db,
          branch,
          inheritedRoles: ["pg_read_all_data"],
        });
      }).pipe(makePlan);

      expect(plan.resources.Db!.action).toBe("update");
      expect(plan.resources.Branch!.action).toBe("update");
      expect(plan.resources.Role!.action).toBe("update");
    }),
  );

  // A rename IS an identity change for downstream consumers: `name` must
  // not be advertised as stable, and the role must plan a replacement.
  test(
    "role still replaces when the branch is renamed",
    Effect.gen(function* () {
      const database = databaseAttrs({});

      yield* seed({
        Branch: stateRow(
          "Branch",
          "Planetscale.PostgresBranch",
          { name: BRANCH_NAME, database },
          branchAttrs(),
        ),
        Role: stateRow(
          "Role",
          "Planetscale.PostgresRole",
          {
            name: ROLE_NAME,
            database,
            branch: branchAttrs(),
            inheritedRoles: ["pg_read_all_data"],
          },
          roleAttrs(),
        ),
      });

      const plan = yield* Effect.gen(function* () {
        const branch = yield* Planetscale.PostgresBranch("Branch", {
          name: "renamed-branch",
          database: database as unknown as Planetscale.PostgresDatabase,
        });
        yield* Planetscale.PostgresRole("Role", {
          name: ROLE_NAME,
          database: database as unknown as Planetscale.PostgresDatabase,
          branch,
          inheritedRoles: ["pg_read_all_data"],
        });
      }).pipe(makePlan);

      expect(plan.resources.Branch!.action).toBe("update");
      expect(plan.resources.Role!.action).toBe("replace");
    }),
  );
});
