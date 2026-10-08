import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import BigQueryConnectionBindingsHost, {
  Cloud,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "BigQueryConnectionBindings",
);

let baseUrl: string;
let connectionName: string;
let hostAccount: string;

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) =>
        (binding.members ?? []).includes(`serviceAccount:${account}`),
      )
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }));
  });

describe.skipIf(!dockerAvailable)(
  "BigQueryConnection Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:bigqueryconnection",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* BigQueryConnectionBindingsHost;
            const connection = yield* Cloud;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              connection: connection.name,
            };
          }),
        );
        baseUrl = out.uri!;
        connectionName = out.connection;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetConnection", () => {
      test.provider(
        "reads the connection as the host's service account, granted on the connection only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              cloudResource?: { serviceAccountId?: string };
            }>(baseUrl, "getConnection");
            const expected =
              yield* bigqueryconnection.getProjectsLocationsConnections({
                name: connectionName,
              });
            expect(live.name).toEqual(connectionName);
            expect(live.cloudResource?.serviceAccountId).toEqual(
              expected.cloudResource?.serviceAccountId,
            );

            const policy =
              yield* bigqueryconnection.getIamPolicyProjectsLocationsConnections(
                {
                  resource: connectionName,
                  body: { options: { requestedPolicyVersion: 3 } },
                },
              );
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => binding.role);
            expect(roles).toEqual(["roles/bigquery.connectionUser"]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual([]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigqueryconnection", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
