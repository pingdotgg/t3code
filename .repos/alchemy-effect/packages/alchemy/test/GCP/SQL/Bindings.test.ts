import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import SqlBindingsHost, {
  Db,
  USER_PASSWORD,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SqlBindings");

// Cloud SQL instances take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let project: string;
let region: string;
let instanceName: string;
let databaseName: string;
let userName: string;
let secretName: string;

/** IAM Condition the bindings scope their project grants with. */
const instanceCondition = () => {
  const name = `projects/${project}/instances/${instanceName}`;
  return `resource.name == "${name}" || resource.name.startsWith("${name}/")`;
};

/**
 * Project-level roles held by the host's service account, with their IAM
 * Condition. Cloud SQL has no instance-level IAM policy.
 */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
          )
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          }))
          .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? "")),
      ),
    );

const expectRole = (role: string) =>
  Effect.gen(function* () {
    expect(yield* projectRoles()).toContainEqual({
      role,
      condition: instanceCondition(),
    });
  });

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "SQL Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:sql", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SqlBindingsHost;
            const { instance, database, user, password } = yield* Db;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              region: instance.region,
              instance: instance.instanceName,
              database: database.databaseName,
              user: user.userName,
              secret: password.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        region = out.region;
        instanceName = out.instance;
        databaseName = out.database;
        userName = out.user;
        secretName = out.secret;

        // The user's password, where Connect and the Data API read it.
        const payload = yield* Effect.sync(() =>
          Buffer.from(USER_PASSWORD, "utf8").toString("base64"),
        );
        yield* Core.withProviders(
          secretmanager.addVersionProjectsLocationsSecrets({
            parent: secretName,
            body: { payload: { data: payload } },
          }),
          testOptions,
          "SqlBindings",
        );
      }),
      { timeout: 1_800_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_200_000 });

    describe("Connect", () => {
      test.provider(
        "queries the database over the Cloud SQL socket as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              connectionName: string;
              socketPath: string;
              username: string;
              database: string;
              passwordMatches: boolean;
              rows: { user: string; database: string }[];
            }>(baseUrl, "connect");
            expect(out.connectionName).toEqual(
              `${project}:${region}:${instanceName}`,
            );
            expect(out.socketPath).toEqual(
              `/cloudsql/${project}:${region}:${instanceName}`,
            );
            expect(out.username).toEqual(userName);
            expect(out.database).toEqual(databaseName);
            expect(out.passwordMatches).toEqual(true);
            expect(out.rows).toEqual([
              { user: userName, database: databaseName },
            ]);

            yield* expectRole("roles/cloudsql.client");
            const secretPolicy =
              yield* secretmanager.getIamPolicyProjectsLocationsSecrets({
                resource: secretName,
              });
            expect(
              (secretPolicy.bindings ?? [])
                .filter((binding) =>
                  (binding.members ?? []).includes(
                    `serviceAccount:${hostAccount}`,
                  ),
                )
                .map((binding) => binding.role),
            ).toEqual(["roles/secretmanager.secretAccessor"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:sql", "live"],
          timeout: 900_000,
        },
      );
    });

    describe("ExecuteSql", () => {
      test.provider(
        "runs a statement through the Data API as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              status: { code?: number } | undefined;
              columns: string[];
              values: string[];
            }>(baseUrl, "executeSql");
            expect(out.status?.code ?? 0).toEqual(0);
            expect(out.columns).toEqual(["who", "answer"]);
            expect(out.values).toEqual([userName, "42"]);
            yield* expectRole("roles/cloudsql.instanceUser");
          }),
        {
          tags: ["provider:gcp", "provider:gcp:sql", "live"],
          timeout: 900_000,
        },
      );
    });

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              name: string;
              state: string;
              connectionName: string;
            }>(baseUrl, "getInstance");
            const live = yield* sqladmin.getInstances({
              project,
              instance: instanceName,
            });
            expect(out.name).toEqual(instanceName);
            expect(out.state).toEqual("RUNNABLE");
            expect(out.connectionName).toEqual(live.connectionName);
            yield* expectRole("roles/cloudsql.viewer");
          }),
        {
          tags: ["provider:gcp", "provider:gcp:sql", "live"],
          timeout: 900_000,
        },
      );
    });

    describe("GetUser", () => {
      test.provider(
        "reads the bound user as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ name: string; instance: string }>(
              baseUrl,
              "getUser",
            );
            expect(out.name).toEqual(userName);
            expect(out.instance).toEqual(instanceName);
            // users.get does not match an instance-scoped IAM Condition.
            expect(yield* projectRoles()).toContainEqual({
              role: "roles/cloudsql.viewer",
              condition: undefined,
            });
          }),
        {
          tags: ["provider:gcp", "provider:gcp:sql", "live"],
          timeout: 900_000,
        },
      );
    });

    describe("grants", () => {
      test.provider(
        "the host holds only the bindings' roles, instance-scoped except GetUser's",
        (_stack) =>
          Effect.gen(function* () {
            // Wait for the probes above so every grant is in place.
            yield* expectProbe(baseUrl, "getInstance");
            const roles = yield* projectRoles();
            expect(roles).toHaveLength(4);
            expect(roles).toEqual(
              expect.arrayContaining([
                ...[
                  "roles/cloudsql.client",
                  "roles/cloudsql.instanceUser",
                  "roles/cloudsql.viewer",
                ].map((role) => ({ role, condition: instanceCondition() })),
                { role: "roles/cloudsql.viewer", condition: undefined },
              ]),
            );
          }),
        {
          tags: ["provider:gcp", "provider:gcp:sql", "live"],
          timeout: 900_000,
        },
      );
    });
  },
);
