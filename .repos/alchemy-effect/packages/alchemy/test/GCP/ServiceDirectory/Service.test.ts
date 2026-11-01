import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  servicedirectory.getProjectsLocationsNamespacesServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, resolve, and delete a service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* GCP.ServiceDirectory.Namespace("Services", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const api = yield* GCP.ServiceDirectory.Service("Api", {
            namespace: ns.name,
            annotations: { protocol: "http" },
          });
          return { ns, api };
        }),
      );

      expect(created.api.name).toContain("/services/");
      expect(created.api.serviceId).toEqual(expect.any(String));
      expect(created.api.namespace).toEqual(created.ns.name);
      expect(created.api.namespaceId).toEqual(created.ns.namespaceId);
      expect(created.api.location).toEqual("us-central1");
      expect(created.api.annotations).toMatchObject({ protocol: "http" });
      expect(created.api.uid).toEqual(expect.any(String));

      const fetched =
        yield* servicedirectory.getProjectsLocationsNamespacesServices({
          name: created.api.name,
        });
      expect(fetched.name).toEqual(created.api.name);
      expect(fetched.annotations?.protocol).toEqual("http");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.uid).toEqual(created.api.uid);

      const resolved =
        yield* servicedirectory.resolveProjectsLocationsNamespacesServices({
          name: created.api.name,
          body: {},
        });
      expect(resolved.service?.name).toEqual(created.api.name);

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
            annotations: { protocol: "grpc", role: "api" },
          });
          return { ns, api };
        }),
      );

      expect(updated.api.name).toEqual(created.api.name);
      expect(updated.api.uid).toEqual(created.api.uid);
      expect(updated.api.annotations).toMatchObject({
        protocol: "grpc",
        role: "api",
      });

      const refetched =
        yield* servicedirectory.getProjectsLocationsNamespacesServices({
          name: created.api.name,
        });
      expect(refetched.annotations?.protocol).toEqual("grpc");
      expect(refetched.annotations?.role).toEqual("api");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.api.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:servicedirectory", "live"],
    timeout: 90_000,
  },
);
