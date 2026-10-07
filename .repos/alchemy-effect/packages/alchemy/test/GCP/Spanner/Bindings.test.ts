import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import SpannerBindingsHost, {
  App,
  Db,
  ITEMS_DDL,
  Schema,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SpannerBindings");

let baseUrl: string;
let member: string;
let names: { instance: string; schema: string; app: string };

type Policy = { bindings?: { role?: string; members?: string[] }[] };

const rolesOf = (policy: Policy) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();

const databaseRoles = (database: string) =>
  spanner
    .getIamPolicyProjectsInstancesDatabases({
      resource: database,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(Effect.map(rolesOf));

const instanceRoles = Effect.suspend(() =>
  spanner
    .getIamPolicyProjectsInstances({
      resource: names.instance,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(Effect.map(rolesOf)),
);

describe.skipIf(!dockerAvailable)(
  "Spanner Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:spanner", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SpannerBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              instance: (yield* Db).name,
              schema: (yield* Schema).name,
              app: (yield* App).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        names = out;
      }),
      { timeout: 1_200_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 900_000 });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance, granted viewer on the instance only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<spanner.Instance>(
              baseUrl,
              "getInstance",
            );
            expect(live.name).toEqual(names.instance);
            expect(live.processingUnits).toEqual(100);
            expect(yield* instanceRoles).toEqual(["roles/spanner.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:spanner", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetDdl", () => {
      test.provider(
        "reads the schema, granted databaseReader on the database only",
        (_stack) =>
          Effect.gen(function* () {
            const ddl = yield* expectProbe<spanner.GetDatabaseDdlResponse>(
              baseUrl,
              "getDdl",
            );
            expect(ddl.statements).toEqual([ITEMS_DDL]);

            const direct = yield* spanner.getDdlProjectsInstancesDatabases({
              database: names.schema,
            });
            expect(ddl.statements).toEqual(direct.statements);

            expect(yield* databaseRoles(names.schema)).toEqual([
              "roles/spanner.databaseReader",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:spanner", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ExecuteSql", () => {
      test.provider(
        "queries the database, granted databaseUser on the database only",
        (_stack) =>
          Effect.gen(function* () {
            const result = yield* expectProbe<spanner.ResultSet>(
              baseUrl,
              "executeSql",
            );
            expect(result.metadata?.rowType?.fields?.[0]?.name).toEqual("n");
            expect(result.rows).toEqual([["0"]]);

            expect(yield* databaseRoles(names.app)).toEqual([
              "roles/spanner.databaseUser",
            ]);
            // Nothing leaks onto the other database or the instance.
            expect(yield* databaseRoles(names.schema)).toEqual([
              "roles/spanner.databaseReader",
            ]);
            expect(yield* instanceRoles).toEqual(["roles/spanner.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:spanner", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
