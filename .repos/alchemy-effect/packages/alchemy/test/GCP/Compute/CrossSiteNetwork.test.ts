import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const waitUntilGone = (project: string, crossSiteNetwork: string) =>
  compute.getCrossSiteNetworks({ project, crossSiteNetwork }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a cross-site network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.CrossSiteNetwork("Backbone", {
            description: "cross-cloud fabric",
          });
        }),
      );

      expect(created.crossSiteNetworkName).toEqual(expect.any(String));
      expect(created.description).toEqual("cross-cloud fabric");

      const fetched = yield* compute.getCrossSiteNetworks({
        project: created.project,
        crossSiteNetwork: created.crossSiteNetworkName,
      });
      expect(fetched.name).toEqual(created.crossSiteNetworkName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("cross-cloud fabric");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.CrossSiteNetwork("Backbone", {
            crossSiteNetworkName: created.crossSiteNetworkName,
            description: "updated fabric",
          });
        }),
      );
      expect(updated.crossSiteNetworkName).toEqual(
        created.crossSiteNetworkName,
      );
      expect(updated.description).toEqual("updated fabric");

      const nextName = `r${created.crossSiteNetworkName}`
        .slice(0, 63)
        .replace(/-+$/, "x");
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.CrossSiteNetwork("Backbone", {
            crossSiteNetworkName: nextName,
            description: "replaced fabric",
          });
        }),
      );
      expect(replaced.crossSiteNetworkName).toEqual(nextName);

      const oldGone = yield* waitUntilGone(
        created.project,
        created.crossSiteNetworkName,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        replaced.project,
        replaced.crossSiteNetworkName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
