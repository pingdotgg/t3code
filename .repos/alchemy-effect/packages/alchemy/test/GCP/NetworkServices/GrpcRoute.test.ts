import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  networkservices.getProjectsLocationsGrpcRoutes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsGrpcRoutes on a missing route fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsGrpcRoutes({
          name: `projects/${project}/locations/global/grpcRoutes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a grpc route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.GrpcRoute("Api", {
            location: "global",
            hostnames: ["alchemy-grpc.example.com"],
            description: "grpc route a",
            labels: { env: "test" },
            rules: [
              {
                action: {
                  retryPolicy: {
                    retryConditions: ["cancelled"],
                    numRetries: 1,
                  },
                },
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/grpcRoutes/");
      expect(created.grpcRouteId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.hostnames).toContain("alchemy-grpc.example.com");
      expect(created.description).toEqual("grpc route a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsGrpcRoutes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("grpc route a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.GrpcRoute("Api", {
            grpcRouteId: created.grpcRouteId,
            location: "global",
            hostnames: ["alchemy-grpc.example.com"],
            description: "grpc route b",
            labels: { env: "prod", role: "grpc" },
            rules: [
              {
                matches: [
                  {
                    method: {
                      grpcService: "api.v1.Orders",
                      grpcMethod: "Get",
                    },
                  },
                ],
                action: {
                  retryPolicy: {
                    retryConditions: ["unavailable"],
                    numRetries: 2,
                  },
                },
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("grpc route b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "grpc" });
      expect(updated.rules[0]?.action?.retryPolicy?.numRetries).toEqual(2);

      const refetched = yield* networkservices.getProjectsLocationsGrpcRoutes({
        name: created.name,
      });
      expect(refetched.description).toEqual("grpc route b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("grpc");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
