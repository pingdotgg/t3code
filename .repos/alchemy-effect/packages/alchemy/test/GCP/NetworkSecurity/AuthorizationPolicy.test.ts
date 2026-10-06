import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  networksecurity.getProjectsLocationsAuthorizationPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an authorization policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.AuthorizationPolicy("Allow", {
            action: "ALLOW",
            description: "authz policy a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/authorizationPolicies/");
      expect(created.name).toContain("/locations/global/");
      expect(created.authorizationPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.action).toEqual("ALLOW");
      expect(created.description).toEqual("authz policy a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsAuthorizationPolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.action).toEqual("ALLOW");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.AuthorizationPolicy("Allow", {
            authorizationPolicyId: created.authorizationPolicyId,
            action: "ALLOW",
            rules: [
              {
                destinations: [{ hosts: ["api.example.com"], ports: [443] }],
              },
            ],
            description: "authz policy b",
            labels: { env: "prod", role: "authz" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("authz policy b");
      expect(updated.rules.length).toBeGreaterThan(0);
      expect(updated.labels).toMatchObject({ env: "prod", role: "authz" });

      const refetched =
        yield* networksecurity.getProjectsLocationsAuthorizationPolicies({
          name: created.name,
        });
      expect(refetched.description).toEqual("authz policy b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.rules?.length).toBeGreaterThan(0);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
