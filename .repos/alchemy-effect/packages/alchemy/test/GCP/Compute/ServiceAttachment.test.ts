import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { DEFAULT_NETWORK, defaultNetworkSelfLink } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";
const healthCheckName = "alchemy-sa-probe";
const backendName = "alchemy-sa-ilb";

const waitUntilGone = (serviceAttachmentName: string, projectId: string) =>
  compute
    .getServiceAttachments({
      project: projectId,
      region,
      serviceAttachment: serviceAttachmentName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitRegionOp = (operation: compute.Operation) => {
  if (operation.status === "DONE") return Effect.succeed(operation);
  const name = (operation.name ?? "").split("/").pop() ?? "";
  return GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getRegionOperations({ project, region, operation: name }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status === "DONE",
          times: 20,
        }),
      ),
    ),
  );
};

const waitGlobalOp = (operation: compute.Operation) => {
  if (operation.status === "DONE") return Effect.succeed(operation);
  const name = (operation.name ?? "").split("/").pop() ?? "";
  return GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getGlobalOperations({ project, operation: name }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status === "DONE",
          times: 20,
        }),
      ),
    ),
  );
};

const ensureProducer = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const existingCheck = yield* compute
      .getHealthChecks({ project, healthCheck: healthCheckName })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    const healthCheck =
      existingCheck ??
      (yield* compute
        .insertHealthChecks({
          project,
          body: {
            name: healthCheckName,
            type: "TCP",
            tcpHealthCheck: { port: 80 },
            checkIntervalSec: 5,
            timeoutSec: 5,
          },
        })
        .pipe(
          Effect.flatMap(waitGlobalOp),
          Effect.catchTag("Conflict", () => Effect.void),
        )
        .pipe(
          Effect.flatMap(() =>
            compute.getHealthChecks({ project, healthCheck: healthCheckName }),
          ),
        ));

    const existingBackend = yield* compute
      .getRegionBackendServices({
        project,
        region,
        backendService: backendName,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    const backend =
      existingBackend ??
      (yield* compute
        .insertRegionBackendServices({
          project,
          region,
          body: {
            name: backendName,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL",
            healthChecks: healthCheck.selfLink ? [healthCheck.selfLink] : [],
          },
        })
        .pipe(
          Effect.flatMap(waitRegionOp),
          Effect.catchTag("Conflict", () => Effect.void),
        )
        .pipe(
          Effect.flatMap(() =>
            compute.getRegionBackendServices({
              project,
              region,
              backendService: backendName,
            }),
          ),
        ));

    return { healthCheck, backend };
  });

const deleteProducer = () =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .deleteRegionBackendServices({
          project,
          region,
          backendService: backendName,
        })
        .pipe(
          Effect.flatMap(waitRegionOp),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        )
        .pipe(
          Effect.flatMap(() =>
            compute
              .deleteHealthChecks({ project, healthCheck: healthCheckName })
              .pipe(
                Effect.flatMap(waitGlobalOp),
                Effect.catchTag("NotFound", () => Effect.void),
                Effect.catchTag("Conflict", () => Effect.void),
              ),
          ),
        ),
    ),
  );

test.provider(
  "create, update, and delete a service attachment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      const producer = yield* ensureProducer();
      expect(producer.backend.selfLink).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet = yield* GCP.Compute.Subnetwork("ProducerSubnet", {
            network: DEFAULT_NETWORK,
            region,
            ipCidrRange: "172.20.2.0/24",
          });
          const nat = yield* GCP.Compute.Subnetwork("NatSubnet", {
            network: DEFAULT_NETWORK,
            region,
            ipCidrRange: "172.20.3.0/24",
            purpose: "PRIVATE_SERVICE_CONNECT",
          });
          const rule = yield* GCP.Compute.ForwardingRule("ProducerFr", {
            region,
            loadBalancingScheme: "INTERNAL",
            backendService: producer.backend.selfLink,
            network: defaultNetworkSelfLink(project),
            subnetwork: subnet.selfLink,
            ipProtocol: "TCP",
            allPorts: true,
          });
          const attachment = yield* GCP.Compute.ServiceAttachment("Producer", {
            region,
            targetService: rule.selfLink.as<string>(),
            natSubnets: [nat.selfLink.as<string>()],
            connectionPreference: "ACCEPT_AUTOMATIC",
            enableProxyProtocol: false,
            description: "psc producer",
            labels: { env: "test" },
          });
          return { subnet, nat, rule, attachment };
        }),
      );

      expect(created.attachment.serviceAttachmentName).toEqual(
        expect.any(String),
      );
      expect(created.attachment.region).toEqual(region);
      expect(created.attachment.connectionPreference).toEqual(
        "ACCEPT_AUTOMATIC",
      );
      expect(created.attachment.enableProxyProtocol).toEqual(false);
      expect(created.attachment.description).toEqual("psc producer");
      expect(created.attachment.labels).toMatchObject({ env: "test" });
      expect(created.attachment.selfLink).toEqual(expect.any(String));
      expect(created.attachment.targetService).toEqual(
        expect.stringContaining(created.rule.forwardingRuleName),
      );
      expect(created.attachment.natSubnets.length).toBeGreaterThan(0);

      const fetched = yield* compute.getServiceAttachments({
        project: created.attachment.project,
        region: created.attachment.region,
        serviceAttachment: created.attachment.serviceAttachmentName,
      });
      expect(fetched.name).toEqual(created.attachment.serviceAttachmentName);
      expect(fetched.connectionPreference).toEqual("ACCEPT_AUTOMATIC");
      expect(fetched.enableProxyProtocol).toEqual(false);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("env=test");
      expect(fetched.description).toContain("psc producer");
      expect(fetched.targetService).toEqual(
        expect.stringContaining(created.rule.forwardingRuleName),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet = yield* GCP.Compute.Subnetwork("ProducerSubnet", {
            subnetworkName: created.subnet.subnetworkName,
            network: DEFAULT_NETWORK,
            region,
            ipCidrRange: "172.20.2.0/24",
          });
          const nat = yield* GCP.Compute.Subnetwork("NatSubnet", {
            subnetworkName: created.nat.subnetworkName,
            network: DEFAULT_NETWORK,
            region,
            ipCidrRange: "172.20.3.0/24",
            purpose: "PRIVATE_SERVICE_CONNECT",
          });
          const rule = yield* GCP.Compute.ForwardingRule("ProducerFr", {
            forwardingRuleName: created.rule.forwardingRuleName,
            region,
            loadBalancingScheme: "INTERNAL",
            backendService: producer.backend.selfLink,
            network: defaultNetworkSelfLink(project),
            subnetwork: subnet.selfLink,
            ipProtocol: "TCP",
            allPorts: true,
          });
          return yield* GCP.Compute.ServiceAttachment("Producer", {
            serviceAttachmentName: created.attachment.serviceAttachmentName,
            region,
            targetService: rule.selfLink.as<string>(),
            natSubnets: [nat.selfLink.as<string>()],
            connectionPreference: "ACCEPT_MANUAL",
            enableProxyProtocol: false,
            consumerAcceptLists: [
              { projectIdOrNum: project, connectionLimit: 10 },
            ],
            reconcileConnections: true,
            description: "psc producer updated",
            labels: { env: "prod", role: "psc" },
          });
        }),
      );

      expect(updated.serviceAttachmentName).toEqual(
        created.attachment.serviceAttachmentName,
      );
      expect(updated.connectionPreference).toEqual("ACCEPT_MANUAL");
      expect(updated.description).toEqual("psc producer updated");
      expect(updated.labels).toMatchObject({ env: "prod", role: "psc" });
      expect(updated.reconcileConnections).toEqual(true);
      expect(
        updated.consumerAcceptLists.some(
          (item) =>
            item.projectIdOrNum === project && item.connectionLimit === 10,
        ),
      ).toEqual(true);

      const fetchedUpdated = yield* compute.getServiceAttachments({
        project: updated.project,
        region: updated.region,
        serviceAttachment: updated.serviceAttachmentName,
      });
      expect(fetchedUpdated.connectionPreference).toEqual("ACCEPT_MANUAL");
      expect(fetchedUpdated.description).toContain("psc producer updated");
      expect(fetchedUpdated.description).toContain("env=prod");
      expect(
        fetchedUpdated.consumerAcceptLists?.some(
          (item) =>
            item.projectIdOrNum === project && item.connectionLimit === 10,
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.attachment.serviceAttachmentName,
        created.attachment.project,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel, Effect.ensuring(deleteProducer().pipe(Effect.ignore))),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 360_000 },
);
