import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  networksecurity.getProjectsLocationsServerTlsPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsServerTlsPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsServerTlsPolicies({
          name: `projects/${project}/locations/global/serverTlsPolicies/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a server tls policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.ServerTlsPolicy("FrontendTls", {
            location: "global",
            description: "server tls a",
            labels: { env: "test" },
            allowOpen: true,
          });
        }),
      );

      expect(created.name).toContain("/serverTlsPolicies/");
      expect(created.name).toContain("/locations/global/");
      expect(created.serverTlsPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("server tls a");
      expect(created.allowOpen).toEqual(true);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsServerTlsPolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("server tls a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.ServerTlsPolicy("FrontendTls", {
            serverTlsPolicyId: created.serverTlsPolicyId,
            location: "global",
            description: "server tls b",
            labels: { env: "prod", role: "tls" },
            allowOpen: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("server tls b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tls" });

      const refetched =
        yield* networksecurity.getProjectsLocationsServerTlsPolicies({
          name: created.name,
        });
      expect(refetched.description).toEqual("server tls b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tls");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);
