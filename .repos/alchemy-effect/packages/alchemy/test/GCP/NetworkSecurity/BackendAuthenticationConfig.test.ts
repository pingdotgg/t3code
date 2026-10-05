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
  networksecurity
    .getProjectsLocationsBackendAuthenticationConfigs({ name })
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
  "create, update, and delete a backend authentication config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.BackendAuthenticationConfig(
            "BackendTls",
            {
              wellKnownRoots: "PUBLIC_ROOTS",
              description: "backend auth a",
              labels: { env: "test" },
            },
          );
        }),
      );

      expect(created.name).toContain("/backendAuthenticationConfigs/");
      expect(created.name).toContain("/locations/global/");
      expect(created.backendAuthenticationConfigId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.wellKnownRoots).toEqual("PUBLIC_ROOTS");
      expect(created.description).toEqual("backend auth a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsBackendAuthenticationConfigs(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.wellKnownRoots).toEqual("PUBLIC_ROOTS");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.BackendAuthenticationConfig(
            "BackendTls",
            {
              backendAuthenticationConfigId:
                created.backendAuthenticationConfigId,
              wellKnownRoots: "PUBLIC_ROOTS",
              description: "backend auth b",
              labels: { env: "prod", role: "backend-tls" },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("backend auth b");
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "backend-tls",
      });

      const refetched =
        yield* networksecurity.getProjectsLocationsBackendAuthenticationConfigs(
          { name: created.name },
        );
      expect(refetched.description).toEqual("backend auth b");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
