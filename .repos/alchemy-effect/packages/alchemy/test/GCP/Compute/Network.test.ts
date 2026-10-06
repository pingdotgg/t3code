import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, networkName: string) =>
  compute.getNetworks({ project, network: networkName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

test.provider(
  "create, update, replace, and delete a network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Network("Vpc", {
            description: "vpc for tests",
            autoCreateSubnetworks: false,
            mtu: 1460,
            routingMode: "REGIONAL",
          });
        }),
      );

      expect(created.networkName).toEqual(expect.any(String));
      expect(created.networkId).toEqual(expect.any(String));
      expect(created.autoCreateSubnetworks).toEqual(false);
      expect(created.description).toEqual("vpc for tests");
      expect(created.mtu).toEqual(1460);
      expect(created.routingMode).toEqual("REGIONAL");
      expect(created.selfLink).toEqual(expect.stringContaining("networks/"));

      const fetched = yield* compute.getNetworks({
        project: created.project,
        network: created.networkName,
      });
      expect(fetched.name).toEqual(created.networkName);
      expect(fetched.autoCreateSubnetworks).toEqual(false);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("vpc for tests");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Network("Vpc", {
            networkName: created.networkName,
            description: "vpc for tests",
            autoCreateSubnetworks: false,
            mtu: 1500,
            routingMode: "GLOBAL",
          });
        }),
      );

      expect(updated.networkName).toEqual(created.networkName);
      expect(updated.networkId).toEqual(created.networkId);
      expect(updated.description).toEqual("vpc for tests");
      expect(updated.mtu).toEqual(1500);
      expect(updated.routingMode).toEqual("GLOBAL");

      const fetchedUpdate = yield* compute.getNetworks({
        project: created.project,
        network: created.networkName,
      });
      expect(fetchedUpdate.mtu).toEqual(1500);
      expect(fetchedUpdate.routingConfig?.routingMode).toEqual("GLOBAL");
      expect(fetchedUpdate.description).toContain("vpc for tests");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Network("Vpc", {
            networkName: created.networkName,
            description: "vpc replaced",
            autoCreateSubnetworks: false,
            mtu: 1500,
            routingMode: "GLOBAL",
          });
        }),
      );

      expect(replaced.networkName).toEqual(created.networkName);
      expect(replaced.description).toEqual("vpc replaced");
      expect(replaced.networkId).not.toEqual(created.networkId);

      const fetchedReplace = yield* compute.getNetworks({
        project: created.project,
        network: created.networkName,
      });
      expect(fetchedReplace.description).toContain("vpc replaced");
      expect(fetchedReplace.mtu).toEqual(1500);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.networkName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
