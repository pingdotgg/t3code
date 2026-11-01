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

const zone = "us-central1-a";

const waitUntilGone = (instanceGroup: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getInstanceGroups({ project, zone, instanceGroup }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
        }),
      ),
    ),
  );

test.provider(
  "create, update, replace, and delete an instance group",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InstanceGroup("Web", {
            zone,
            description: "unmanaged backends",
            namedPorts: [{ name: "http", port: 80 }],
          });
        }),
      );

      expect(created.instanceGroupName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.description).toEqual("unmanaged backends");
      expect(created.namedPorts).toEqual([{ name: "http", port: 80 }]);
      expect(created.size).toEqual(0);

      const fetched = yield* compute.getInstanceGroups({
        project,
        zone,
        instanceGroup: created.instanceGroupName,
      });
      expect(fetched.name).toEqual(created.instanceGroupName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("unmanaged backends");
      expect(fetched.namedPorts?.some((port) => port.name === "http")).toEqual(
        true,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InstanceGroup("Web", {
            instanceGroupName: created.instanceGroupName,
            zone,
            description: "unmanaged backends",
            namedPorts: [
              { name: "http", port: 80 },
              { name: "https", port: 443 },
            ],
          });
        }),
      );

      expect(updated.instanceGroupName).toEqual(created.instanceGroupName);
      expect(updated.id).toEqual(created.id);
      expect(updated.namedPorts).toEqual([
        { name: "http", port: 80 },
        { name: "https", port: 443 },
      ]);

      const refetched = yield* compute.getInstanceGroups({
        project,
        zone,
        instanceGroup: updated.instanceGroupName,
      });
      expect(
        (refetched.namedPorts ?? []).map((port) => port.name).sort(),
      ).toEqual(["http", "https"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.InstanceGroup("Web", {
            instanceGroupName: created.instanceGroupName,
            zone,
            description: "replaced backends",
            namedPorts: [
              { name: "http", port: 80 },
              { name: "https", port: 443 },
            ],
          });
        }),
      );

      expect(replaced.instanceGroupName).toEqual(created.instanceGroupName);
      expect(replaced.description).toEqual("replaced backends");
      expect(replaced.id).not.toEqual(created.id);

      const replacedFetched = yield* compute.getInstanceGroups({
        project,
        zone,
        instanceGroup: replaced.instanceGroupName,
      });
      expect(replacedFetched.description).toContain("replaced backends");
      expect(replacedFetched.id).toEqual(replaced.id);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.instanceGroupName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
