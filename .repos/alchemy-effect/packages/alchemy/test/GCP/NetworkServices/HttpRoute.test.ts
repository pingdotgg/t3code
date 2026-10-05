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
  networkservices.getProjectsLocationsHttpRoutes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsHttpRoutes on a missing route fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsHttpRoutes({
          name: `projects/${project}/locations/global/httpRoutes/alchemy-missing`,
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
  "create, update, and delete an http route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.HttpRoute("Web", {
            location: "global",
            hostnames: ["alchemy-http.example.com"],
            description: "http route a",
            labels: { env: "test" },
            rules: [
              {
                matches: [{ prefixMatch: "/" }],
                action: {
                  redirect: {
                    hostRedirect: "example.com",
                    httpsRedirect: true,
                  },
                },
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/httpRoutes/");
      expect(created.httpRouteId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.hostnames).toContain("alchemy-http.example.com");
      expect(created.description).toEqual("http route a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsHttpRoutes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("http route a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.HttpRoute("Web", {
            httpRouteId: created.httpRouteId,
            location: "global",
            hostnames: ["alchemy-http.example.com"],
            description: "http route b",
            labels: { env: "prod", role: "http" },
            rules: [
              {
                matches: [{ fullPathMatch: "/healthz" }],
                action: {
                  directResponse: { status: 200, stringBody: "ok" },
                },
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("http route b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "http" });
      expect(updated.rules[0]?.action?.directResponse?.status).toEqual(200);

      const refetched = yield* networkservices.getProjectsLocationsHttpRoutes({
        name: created.name,
      });
      expect(refetched.description).toEqual("http route b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("http");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
