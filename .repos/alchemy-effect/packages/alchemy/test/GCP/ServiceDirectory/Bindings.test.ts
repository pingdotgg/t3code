import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ServiceDirectoryBindingsHost, {
  Api,
  ENDPOINT_ADDRESS,
  ENDPOINT_PORT,
  Https,
  Registry,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ServiceDirectoryBindings");

let baseUrl: string;
let member: string;
let serviceName: string;
let endpointName: string;
let namespaceName: string;

/** Roles the host's service account holds on the bound service. */
const hostRolesOnService = Effect.gen(function* () {
  const policy =
    yield* servicedirectory.getIamPolicyProjectsLocationsNamespacesServices({
      resource: serviceName,
      body: { options: { requestedPolicyVersion: 3 } },
    });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();
});

/** Roles the host's service account holds on the parent namespace. */
const hostRolesOnNamespace = Effect.gen(function* () {
  const policy =
    yield* servicedirectory.getIamPolicyProjectsLocationsNamespaces({
      resource: namespaceName,
      body: { options: { requestedPolicyVersion: 3 } },
    });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role);
});

describe.skipIf(!dockerAvailable)(
  "ServiceDirectory Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:servicedirectory",
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
            const host = yield* ServiceDirectoryBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              namespace: (yield* Registry).name,
              service: (yield* Api).name,
              endpoint: (yield* Https).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        namespaceName = out.namespace;
        serviceName = out.service;
        endpointName = out.endpoint;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Resolve", () => {
      test.provider(
        "resolves the service with its endpoints, granted viewer on the service only",
        (_stack) =>
          Effect.gen(function* () {
            const out =
              yield* expectProbe<servicedirectory.ResolveServiceResponse>(
                baseUrl,
                "resolve",
              );
            expect(out.service?.name).toEqual(serviceName);
            expect(
              (out.service?.endpoints ?? []).map((endpoint) => ({
                name: endpoint.name,
                address: endpoint.address,
                port: endpoint.port,
              })),
            ).toEqual([
              {
                name: endpointName,
                address: ENDPOINT_ADDRESS,
                port: ENDPOINT_PORT,
              },
            ]);

            expect(yield* hostRolesOnService).toEqual([
              "roles/servicedirectory.viewer",
            ]);
            expect(yield* hostRolesOnNamespace).toEqual([]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:servicedirectory", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetEndpoint", () => {
      test.provider(
        "reads the endpoint, granted viewer on its service only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<servicedirectory.Endpoint>(
              baseUrl,
              "getEndpoint",
            );
            expect(live.name).toEqual(endpointName);
            expect(live.address).toEqual(ENDPOINT_ADDRESS);
            expect(live.port).toEqual(ENDPOINT_PORT);

            // Out of band: the deployer sees the same endpoint.
            const direct =
              yield* servicedirectory.getProjectsLocationsNamespacesServicesEndpoints(
                { name: endpointName },
              );
            expect(direct.uid).toEqual(live.uid);

            expect(yield* hostRolesOnService).toEqual([
              "roles/servicedirectory.viewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:servicedirectory", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
