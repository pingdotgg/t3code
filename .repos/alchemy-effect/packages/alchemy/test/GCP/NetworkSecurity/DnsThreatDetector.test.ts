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
  networksecurity.getProjectsLocationsDnsThreatDetectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDnsThreatDetectors on a missing detector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsDnsThreatDetectors({
          name: `projects/${project}/locations/global/dnsThreatDetectors/alchemy-missing`,
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
  "create, update, and delete a dns threat detector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.DnsThreatDetector("Armor", {
            location: "global",
            provider: "INFOBLOX",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dnsThreatDetectors/");
      expect(created.dnsThreatDetectorId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.provider).toEqual("INFOBLOX");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networksecurity.getProjectsLocationsDnsThreatDetectors({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.provider).toEqual("INFOBLOX");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.DnsThreatDetector("Armor", {
            dnsThreatDetectorId: created.dnsThreatDetectorId,
            location: "global",
            provider: "INFOBLOX",
            labels: { env: "prod", role: "dns" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.provider).toEqual("INFOBLOX");
      expect(updated.labels).toMatchObject({ env: "prod", role: "dns" });

      const refetched =
        yield* networksecurity.getProjectsLocationsDnsThreatDetectors({
          name: created.name,
        });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("dns");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
    exclusive: true,
  },
);
