import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  servicedirectory
    .getProjectsLocationsNamespacesServicesEndpoints({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsNamespacesServicesEndpoints on a missing endpoint fails with NotFound",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      const error = yield* Effect.flip(
        servicedirectory.getProjectsLocationsNamespacesServicesEndpoints({
          name: `projects/${project}/locations/us-central1/namespaces/alchemy-endpoint-missing/services/api/endpoints/missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:servicedirectory", "live"] },
);

test.provider(
  "create, update, replace, and delete an endpoint",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* GCP.ServiceDirectory.Namespace("Services", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const api = yield* GCP.ServiceDirectory.Service("Api", {
            namespace: ns.name,
          });
          const endpoint = yield* GCP.ServiceDirectory.Endpoint("Https", {
            service: api.name,
            address: "10.0.0.1",
            port: 8080,
            annotations: { protocol: "http" },
          });
          return { ns, api, endpoint };
        }),
      );

      expect(created.endpoint.name).toContain("/endpoints/");
      expect(created.endpoint.endpointId).toEqual(expect.any(String));
      expect(created.endpoint.service).toEqual(created.api.name);
      expect(created.endpoint.namespace).toEqual(created.ns.name);
      expect(created.endpoint.location).toEqual("us-central1");
      expect(created.endpoint.project).toEqual(project);
      expect(created.endpoint.address).toEqual("10.0.0.1");
      expect(created.endpoint.port).toEqual(8080);
      expect(created.endpoint.annotations).toMatchObject({ protocol: "http" });
      expect(created.endpoint.uid).toEqual(expect.any(String));

      const fetched =
        yield* servicedirectory.getProjectsLocationsNamespacesServicesEndpoints(
          {
            name: created.endpoint.name,
          },
        );
      expect(fetched.name).toEqual(created.endpoint.name);
      expect(fetched.address).toEqual("10.0.0.1");
      expect(fetched.port).toEqual(8080);
      expect(fetched.annotations?.protocol).toEqual("http");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.uid).toEqual(created.endpoint.uid);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* GCP.ServiceDirectory.Namespace("Services", {
            namespaceId: created.ns.namespaceId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const api = yield* GCP.ServiceDirectory.Service("Api", {
            namespace: ns.name,
            serviceId: created.api.serviceId,
          });
          const endpoint = yield* GCP.ServiceDirectory.Endpoint("Https", {
            service: api.name,
            endpointId: created.endpoint.endpointId,
            address: "10.0.0.2",
            port: 443,
            annotations: { protocol: "https", role: "api" },
          });
          return { ns, api, endpoint };
        }),
      );

      expect(updated.endpoint.name).toEqual(created.endpoint.name);
      expect(updated.endpoint.uid).toEqual(created.endpoint.uid);
      expect(updated.endpoint.address).toEqual("10.0.0.2");
      expect(updated.endpoint.port).toEqual(443);
      expect(updated.endpoint.annotations).toMatchObject({
        protocol: "https",
        role: "api",
      });

      const refetched =
        yield* servicedirectory.getProjectsLocationsNamespacesServicesEndpoints(
          {
            name: created.endpoint.name,
          },
        );
      expect(refetched.address).toEqual("10.0.0.2");
      expect(refetched.port).toEqual(443);
      expect(refetched.annotations?.protocol).toEqual("https");
      expect(refetched.annotations?.role).toEqual("api");

      const last = created.endpoint.endpointId.at(-1) ?? "a";
      const nextEndpointId = `${created.endpoint.endpointId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* GCP.ServiceDirectory.Namespace("Services", {
            namespaceId: created.ns.namespaceId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const api = yield* GCP.ServiceDirectory.Service("Api", {
            namespace: ns.name,
            serviceId: created.api.serviceId,
          });
          const endpoint = yield* GCP.ServiceDirectory.Endpoint("Https", {
            service: api.name,
            endpointId: nextEndpointId,
            address: "10.0.0.3",
            port: 8443,
            annotations: { protocol: "https" },
          });
          return { ns, api, endpoint };
        }),
      );

      expect(replaced.endpoint.name).not.toEqual(created.endpoint.name);
      expect(replaced.endpoint.endpointId).toEqual(nextEndpointId);
      expect(replaced.endpoint.address).toEqual("10.0.0.3");
      expect(replaced.endpoint.port).toEqual(8443);

      const fetchedReplacement =
        yield* servicedirectory.getProjectsLocationsNamespacesServicesEndpoints(
          {
            name: replaced.endpoint.name,
          },
        );
      expect(fetchedReplacement.name).toEqual(replaced.endpoint.name);
      expect(fetchedReplacement.address).toEqual("10.0.0.3");

      const previousGone = yield* waitUntilGone(created.endpoint.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.endpoint.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:servicedirectory", "live"],
    timeout: 90_000,
  },
);
