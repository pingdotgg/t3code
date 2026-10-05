import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as iap from "@distilled.cloud/gcp/iap_v1";
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
  iap.getProjectsIap_tunnelLocationsDestGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsIap_tunnelLocationsDestGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.getProjectsIap_tunnelLocationsDestGroups({
          name: `projects/${project}/iap_tunnel/locations/us-central1/destGroups/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iap", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete an IAP tunnel dest group",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAP.IapDestGroup("SshHosts", {
            location: "us-central1",
            cidrs: ["10.241.0.0/24"],
          });
        }),
      );

      expect(created.name).toContain("/destGroups/");
      expect(created.destGroupId.length).toBeGreaterThanOrEqual(4);
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.cidrs).toEqual(["10.241.0.0/24"]);
      expect(created.fqdns).toEqual([]);

      const fetched = yield* iap.getProjectsIap_tunnelLocationsDestGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.cidrs).toContain("10.241.0.0/24");
      expect(fetched.fqdns ?? []).toEqual([]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAP.IapDestGroup("SshHosts", {
            location: "us-central1",
            cidrs: ["10.241.0.0/24", "10.241.1.0/24"],
            fqdns: ["db.internal.example.com"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.cidrs.sort()).toEqual(
        ["10.241.0.0/24", "10.241.1.0/24"].sort(),
      );
      expect(updated.fqdns).toEqual(["db.internal.example.com"]);

      const fetchedUpdate = yield* iap.getProjectsIap_tunnelLocationsDestGroups(
        {
          name: created.name,
        },
      );
      expect(fetchedUpdate.cidrs?.sort()).toEqual(
        ["10.241.0.0/24", "10.241.1.0/24"].sort(),
      );
      expect(fetchedUpdate.fqdns).toEqual(["db.internal.example.com"]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iap", "live"], timeout: 90_000 },
);
