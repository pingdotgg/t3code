import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  callProbe,
  dockerAvailable,
  type ProbeOutcome,
} from "../bindingHost.ts";
import DataConnectBindingsHost, {
  App,
  Queries,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataConnectBindings");

let baseUrl: string;
let serviceName: string;
let connectorName: string;
let hostAccount: string;

/**
 * Roles the host's service account holds on the project. Data Connect has
 * no resource-level IAM, so every binding grants on the project.
 */
const hostProjectRoles = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
});

const expectedRoles = [
  { role: "roles/firebasedataconnect.dataAdmin", condition: undefined },
  { role: "roles/firebasedataconnect.dataViewer", condition: undefined },
];

/** Tag of a direct (deployer-credential) call, for comparison. */
const tagOf = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * The test service's datasource is unlinked (no Cloud SQL), so data-plane
 * calls that pass IAM reach the service and are rejected with
 * `BadRequest: MISSING_DATASOURCE`. A missing grant surfaces as
 * `Forbidden`/`PermissionDenied` (which `callProbe` retries until it
 * propagates, then returns).
 */
const expectAuthorized = (outcome: ProbeOutcome<unknown>) => {
  if (outcome.ok) return "ok";
  expect(outcome.error._tag).toEqual("BadRequest");
  expect(outcome.error.message ?? "").toContain("MISSING_DATASOURCE");
  return outcome.error._tag;
};

describe.skipIf(!dockerAvailable)(
  "FirebaseDataConnect Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:firebasedataconnect",
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
            const host = yield* DataConnectBindingsHost;
            const service = yield* App;
            const connector = yield* Queries;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              service: service.name,
              connector: connector.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        serviceName = out.service;
        connectorName = out.connector;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("ExecuteGraphql", () => {
      test.provider(
        "executes GraphQL on the service as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const outcome = yield* callProbe(baseUrl, "executeGraphql");
            const tag = expectAuthorized(outcome);
            const direct = yield* tagOf(
              firebasedataconnect.executeGraphqlProjectsLocationsServices({
                name: serviceName,
                body: { query: "{ __typename }" },
              }),
            );
            expect(tag).toEqual(direct);
            expect(yield* hostProjectRoles).toEqual(expectedRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebasedataconnect", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ExecuteGraphqlRead", () => {
      test.provider(
        "executes read-only GraphQL on the service as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const outcome = yield* callProbe(baseUrl, "executeGraphqlRead");
            const tag = expectAuthorized(outcome);
            const direct = yield* tagOf(
              firebasedataconnect.executeGraphqlReadProjectsLocationsServices({
                name: serviceName,
                body: { query: "{ __typename }" },
              }),
            );
            expect(tag).toEqual(direct);
            expect(yield* hostProjectRoles).toEqual(expectedRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebasedataconnect", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ExecuteQuery", () => {
      test.provider(
        "executes the connector's query as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const outcome = yield* callProbe(baseUrl, "executeQuery");
            const tag = expectAuthorized(outcome);
            const direct = yield* tagOf(
              firebasedataconnect.executeQueryProjectsLocationsServicesConnectors(
                {
                  name: connectorName,
                  body: { operationName: "ListAlchemyNotes" },
                },
              ),
            );
            expect(tag).toEqual(direct);
            expect(yield* hostProjectRoles).toEqual(expectedRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebasedataconnect", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ExecuteMutation", () => {
      test.provider(
        "executes the connector's mutation as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const outcome = yield* callProbe(baseUrl, "executeMutation");
            const tag = expectAuthorized(outcome);
            const direct = yield* tagOf(
              firebasedataconnect.executeMutationProjectsLocationsServicesConnectors(
                {
                  name: connectorName,
                  body: {
                    operationName: "CreateAlchemyNote",
                    variables: { title: "hello" },
                  },
                },
              ),
            );
            expect(tag).toEqual(direct);
            expect(yield* hostProjectRoles).toEqual(expectedRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebasedataconnect", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
