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
const zone = "us-central1-a";
const names = {
  healthCheck: "alchemy-pm-hc",
  instanceGroup: "alchemy-pm-ig",
  backend: "alchemy-pm-bs",
  forwardingRule: "alchemy-pm-fr",
};

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const waitUntilGone = (packetMirroringName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getPacketMirrorings({
          project,
          region,
          packetMirroring: packetMirroringName,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

const waitOp = (
  operation: compute.Operation,
  scope: "global" | "region" | "zone",
) => {
  if (operation.status === "DONE") return Effect.succeed(operation);
  const name = lastSegment(operation.name);
  if (name.length === 0) return Effect.succeed(operation);
  return GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) => {
      const poll =
        scope === "global"
          ? compute.getGlobalOperations({ project, operation: name })
          : scope === "zone"
            ? compute.getZoneOperations({ project, zone, operation: name })
            : compute.getRegionOperations({ project, region, operation: name });
      return poll.pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed({ status: "DONE" } as compute.Operation),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status === "DONE",
          times: 8,
        }),
      );
    }),
  );
};

const ensureCollector = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const network = yield* compute.getNetworks({
      project,
      network: "default",
    });
    const subnet = yield* compute.getSubnetworks({
      project,
      region,
      subnetwork: "default",
    });

    const healthCheck = yield* compute
      .getHealthChecks({ project, healthCheck: names.healthCheck })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (healthCheck === undefined) {
      yield* compute
        .insertHealthChecks({
          project,
          body: {
            name: names.healthCheck,
            type: "TCP",
            tcpHealthCheck: { port: 80 },
            description: "alchemy packet-mirroring collector",
          },
        })
        .pipe(
          Effect.flatMap((operation) => waitOp(operation, "global")),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }

    const instanceGroup = yield* compute
      .getInstanceGroups({
        project,
        zone,
        instanceGroup: names.instanceGroup,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (instanceGroup === undefined) {
      yield* compute
        .insertInstanceGroups({
          project,
          zone,
          body: {
            name: names.instanceGroup,
            network: network.selfLink,
            description: "alchemy packet-mirroring collector",
          },
        })
        .pipe(
          Effect.flatMap((operation) => waitOp(operation, "zone")),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }

    const backend = yield* compute
      .getRegionBackendServices({
        project,
        region,
        backendService: names.backend,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (backend === undefined) {
      const hc = yield* compute.getHealthChecks({
        project,
        healthCheck: names.healthCheck,
      });
      const group = yield* compute.getInstanceGroups({
        project,
        zone,
        instanceGroup: names.instanceGroup,
      });
      yield* compute
        .insertRegionBackendServices({
          project,
          region,
          body: {
            name: names.backend,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL",
            healthChecks: hc.selfLink ? [hc.selfLink] : undefined,
            backends: group.selfLink ? [{ group: group.selfLink }] : undefined,
            network: network.selfLink,
            description: "alchemy packet-mirroring collector",
          },
        })
        .pipe(
          Effect.flatMap((operation) => waitOp(operation, "region")),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }

    const rule = yield* compute
      .getForwardingRules({
        project,
        region,
        forwardingRule: names.forwardingRule,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (rule === undefined) {
      const backendService = yield* compute.getRegionBackendServices({
        project,
        region,
        backendService: names.backend,
      });
      yield* compute
        .insertForwardingRules({
          project,
          region,
          body: {
            name: names.forwardingRule,
            loadBalancingScheme: "INTERNAL",
            isMirroringCollector: true,
            IPProtocol: "TCP",
            allPorts: true,
            backendService: backendService.selfLink,
            network: network.selfLink,
            subnetwork: subnet.selfLink,
            description: "alchemy packet-mirroring collector",
          },
        })
        .pipe(
          Effect.flatMap((operation) => waitOp(operation, "region")),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }

    const forwardingRule = yield* compute.getForwardingRules({
      project,
      region,
      forwardingRule: names.forwardingRule,
    });
    return {
      network:
        network.selfLink ?? `projects/${project}/global/networks/default`,
      forwardingRule:
        forwardingRule.selfLink ??
        `projects/${project}/regions/${region}/forwardingRules/${names.forwardingRule}`,
    };
  });

const deleteCollector = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    yield* compute
      .deleteForwardingRules({
        project,
        region,
        forwardingRule: names.forwardingRule,
      })
      .pipe(
        Effect.flatMap((operation) => waitOp(operation, "region")),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      );
    yield* compute
      .deleteRegionBackendServices({
        project,
        region,
        backendService: names.backend,
      })
      .pipe(
        Effect.flatMap((operation) => waitOp(operation, "region")),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      );
    yield* compute
      .deleteInstanceGroups({
        project,
        zone,
        instanceGroup: names.instanceGroup,
      })
      .pipe(
        Effect.flatMap((operation) => waitOp(operation, "zone")),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      );
    yield* compute
      .deleteHealthChecks({ project, healthCheck: names.healthCheck })
      .pipe(
        Effect.flatMap((operation) => waitOp(operation, "global")),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      );
  });

test.provider(
  "create, update, replace, and delete a packet mirroring policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const collector = yield* ensureCollector();
      expect(collector.forwardingRule).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.PacketMirroring("Capture", {
            region,
            description: "test capture",
            network: collector.network,
            collectorIlb: collector.forwardingRule,
            mirroredResources: { tags: ["alchemy-pm"] },
          });
        }),
      );

      expect(created.packetMirroringName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("test capture");
      expect(created.enable).toEqual(true);
      expect(created.priority).toEqual(1000);
      expect(created.network).toEqual(expect.stringContaining("networks/"));
      expect(created.collectorIlb).toEqual(
        expect.stringContaining(names.forwardingRule),
      );
      expect(created.mirroredResources.tags).toEqual(["alchemy-pm"]);

      const fetched = yield* compute.getPacketMirrorings({
        project: created.project,
        region: created.region,
        packetMirroring: created.packetMirroringName,
      });
      expect(fetched.name).toEqual(created.packetMirroringName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("test capture");
      expect(fetched.enable).toEqual("TRUE");
      expect(fetched.mirroredResources?.tags).toEqual(["alchemy-pm"]);
      expect(fetched.collectorIlb?.url).toEqual(
        expect.stringContaining(names.forwardingRule),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.PacketMirroring("Capture", {
            packetMirroringName: created.packetMirroringName,
            region,
            description: "test capture",
            network: collector.network,
            collectorIlb: collector.forwardingRule,
            mirroredResources: { tags: ["alchemy-pm", "alchemy-pm-web"] },
            enable: false,
            priority: 800,
            filter: {
              direction: "INGRESS",
              ipProtocols: ["tcp"],
              cidrRanges: ["10.0.0.0/8"],
            },
          });
        }),
      );

      expect(updated.packetMirroringName).toEqual(created.packetMirroringName);
      expect(updated.packetMirroringId).toEqual(created.packetMirroringId);
      expect(updated.enable).toEqual(false);
      expect(updated.priority).toEqual(800);
      expect([...updated.mirroredResources.tags].sort()).toEqual(
        ["alchemy-pm", "alchemy-pm-web"].sort(),
      );
      expect(updated.filter?.direction).toEqual("INGRESS");
      expect(updated.filter?.ipProtocols).toEqual(["tcp"]);
      expect(updated.filter?.cidrRanges).toEqual(["10.0.0.0/8"]);

      const fetchedUpdate = yield* compute.getPacketMirrorings({
        project: updated.project,
        region: updated.region,
        packetMirroring: updated.packetMirroringName,
      });
      expect(fetchedUpdate.enable).toEqual("FALSE");
      expect(fetchedUpdate.priority).toEqual(800);
      expect(fetchedUpdate.filter?.direction).toEqual("INGRESS");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.PacketMirroring("Capture", {
            packetMirroringName: created.packetMirroringName,
            region,
            description: "replaced capture",
            network: collector.network,
            collectorIlb: collector.forwardingRule,
            mirroredResources: { tags: ["alchemy-pm"] },
          });
        }),
      );

      expect(replaced.packetMirroringName).toEqual(created.packetMirroringName);
      expect(replaced.description).toEqual("replaced capture");
      expect(replaced.enable).toEqual(true);
      expect(replaced.packetMirroringId).not.toEqual(created.packetMirroringId);

      const fetchedReplace = yield* compute.getPacketMirrorings({
        project: replaced.project,
        region: replaced.region,
        packetMirroring: replaced.packetMirroringName,
      });
      expect(fetchedReplace.description).toContain("replaced capture");
      expect(fetchedReplace.enable).toEqual("TRUE");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.packetMirroringName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, Effect.ensuring(deleteCollector().pipe(Effect.ignore))),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
