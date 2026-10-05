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

const region = "us-central1";

const waitUntilGone = (managerName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getRegionInstanceGroupManagers({
          project,
          region,
          instanceGroupManager: managerName,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (status) => status === "gone",
            times: 15,
          }),
        ),
    ),
  );

const templateProps: GCP.Compute.InstanceTemplateProps = {
  machineType: "e2-micro",
  disks: [
    {
      boot: true,
      autoDelete: true,
      sourceImage: "projects/debian-cloud/global/images/family/debian-12",
      diskSizeGb: 10,
    },
  ],
  networkInterfaces: [{ network: "global/networks/default" }],
};

test.provider(
  "create, update, replace, and delete a regional instance group manager",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Web",
            templateProps,
          );
          const manager = yield* GCP.Compute.RegionInstanceGroupManager(
            "WebMig",
            {
              region,
              instanceTemplate: template.selfLink.as<string>(),
              baseInstanceName: "web",
              targetSize: 0,
              description: "regional mig",
              namedPorts: [{ name: "http", port: 80 }],
            },
          );
          return { template, manager };
        }),
      );

      expect(created.manager.managerName).toEqual(expect.any(String));
      expect(created.manager.region).toEqual(region);
      expect(created.manager.targetSize).toEqual(0);
      expect(created.manager.baseInstanceName).toEqual("web");
      expect(created.manager.description).toEqual("regional mig");
      expect(created.manager.namedPorts).toEqual([{ name: "http", port: 80 }]);
      expect(created.manager.instanceTemplate).toEqual(expect.any(String));
      expect(created.manager.project).toEqual(project);

      const fetched = yield* compute.getRegionInstanceGroupManagers({
        project,
        region,
        instanceGroupManager: created.manager.managerName,
      });
      expect(fetched.name).toEqual(created.manager.managerName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("regional mig");
      expect(fetched.targetSize).toEqual(0);
      expect(fetched.baseInstanceName).toEqual("web");
      expect(
        (fetched.namedPorts ?? []).some((port) => port.name === "http"),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Web",
            templateProps,
          );
          const manager = yield* GCP.Compute.RegionInstanceGroupManager(
            "WebMig",
            {
              managerName: created.manager.managerName,
              region,
              instanceTemplate: template.selfLink.as<string>(),
              baseInstanceName: "web",
              targetSize: 0,
              description: "regional mig",
              namedPorts: [
                { name: "http", port: 80 },
                { name: "https", port: 443 },
              ],
            },
          );
          return { template, manager };
        }),
      );

      expect(updated.manager.managerName).toEqual(created.manager.managerName);
      expect(updated.manager.managerId).toEqual(created.manager.managerId);
      expect(updated.manager.namedPorts).toEqual([
        { name: "http", port: 80 },
        { name: "https", port: 443 },
      ]);

      const refetched = yield* compute.getRegionInstanceGroupManagers({
        project,
        region,
        instanceGroupManager: updated.manager.managerName,
      });
      expect(
        (refetched.namedPorts ?? []).map((port) => port.name).sort(),
      ).toEqual(["http", "https"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Web",
            templateProps,
          );
          const manager = yield* GCP.Compute.RegionInstanceGroupManager(
            "WebMig",
            {
              managerName: created.manager.managerName,
              region,
              instanceTemplate: template.selfLink.as<string>(),
              baseInstanceName: "app",
              targetSize: 0,
              description: "replaced mig",
              namedPorts: [
                { name: "http", port: 80 },
                { name: "https", port: 443 },
              ],
            },
          );
          return { template, manager };
        }),
      );

      expect(replaced.manager.managerName).toEqual(created.manager.managerName);
      expect(replaced.manager.baseInstanceName).toEqual("app");
      expect(replaced.manager.description).toEqual("replaced mig");
      expect(replaced.manager.managerId).not.toEqual(created.manager.managerId);

      const replacedFetched = yield* compute.getRegionInstanceGroupManagers({
        project,
        region,
        instanceGroupManager: replaced.manager.managerName,
      });
      expect(replacedFetched.baseInstanceName).toEqual("app");
      expect(replacedFetched.description).toContain("replaced mig");
      expect(replacedFetched.id).toEqual(replaced.manager.managerId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.manager.managerName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
