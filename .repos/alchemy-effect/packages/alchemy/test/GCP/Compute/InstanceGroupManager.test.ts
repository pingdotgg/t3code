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
const replaceZone = "us-central1-b";

const waitUntilGone = (zoneName: string, instanceGroupManager: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getInstanceGroupManagers({
          project,
          zone: zoneName,
          instanceGroupManager,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
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
  "create, update, replace, and delete an instance group manager",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate("Template", {
            ...templateProps,
          });
          const manager = yield* GCP.Compute.InstanceGroupManager("Manager", {
            zone,
            instanceTemplate: template.templateName,
            targetSize: 0,
            description: "test mig",
            namedPorts: [{ name: "http", port: 80 }],
          });
          return { template, manager };
        }),
      );

      expect(created.manager.managerName).toEqual(expect.any(String));
      expect(created.manager.zone).toEqual(zone);
      expect(created.manager.targetSize).toEqual(0);
      expect(created.manager.description).toEqual("test mig");
      expect(created.manager.namedPorts).toEqual([{ name: "http", port: 80 }]);
      expect(created.manager.project).toEqual(project);

      const fetched = yield* compute.getInstanceGroupManagers({
        project,
        zone,
        instanceGroupManager: created.manager.managerName,
      });
      expect(fetched.name).toEqual(created.manager.managerName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("test mig");
      expect(fetched.targetSize).toEqual(0);
      expect(fetched.namedPorts?.some((port) => port.name === "http")).toEqual(
        true,
      );
      expect(fetched.instanceTemplate).toContain(created.template.templateName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate("Template", {
            ...templateProps,
          });
          const manager = yield* GCP.Compute.InstanceGroupManager("Manager", {
            managerName: created.manager.managerName,
            zone,
            instanceTemplate: template.templateName,
            targetSize: 0,
            description: "updated mig",
            namedPorts: [
              { name: "http", port: 80 },
              { name: "https", port: 443 },
            ],
          });
          return { template, manager };
        }),
      );

      expect(updated.manager.managerName).toEqual(created.manager.managerName);
      expect(updated.manager.id).toEqual(created.manager.id);
      expect(updated.manager.description).toEqual("updated mig");
      expect(updated.manager.namedPorts).toEqual([
        { name: "http", port: 80 },
        { name: "https", port: 443 },
      ]);

      const refetched = yield* compute.getInstanceGroupManagers({
        project,
        zone,
        instanceGroupManager: updated.manager.managerName,
      });
      expect(refetched.description).toContain("updated mig");
      expect(
        (refetched.namedPorts ?? []).map((port) => port.name).sort(),
      ).toEqual(["http", "https"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate("Template", {
            ...templateProps,
          });
          const manager = yield* GCP.Compute.InstanceGroupManager("Manager", {
            managerName: created.manager.managerName,
            zone: replaceZone,
            instanceTemplate: template.templateName,
            targetSize: 0,
            description: "updated mig",
            namedPorts: [
              { name: "http", port: 80 },
              { name: "https", port: 443 },
            ],
          });
          return { template, manager };
        }),
      );

      expect(replaced.manager.managerName).toEqual(created.manager.managerName);
      expect(replaced.manager.zone).toEqual(replaceZone);
      expect(replaced.manager.id).not.toEqual(created.manager.id);

      const replacedFetched = yield* compute.getInstanceGroupManagers({
        project,
        zone: replaceZone,
        instanceGroupManager: replaced.manager.managerName,
      });
      expect(replacedFetched.zone).toContain(replaceZone);
      expect(replacedFetched.id).toEqual(replaced.manager.id);

      const oldGone = yield* waitUntilGone(zone, created.manager.managerName);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaceZone,
        replaced.manager.managerName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
