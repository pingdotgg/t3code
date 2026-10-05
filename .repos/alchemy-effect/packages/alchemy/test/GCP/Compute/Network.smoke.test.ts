import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import { DestroyError } from "@/Apply";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import EgressFunction, {
  APP_CIDR,
  AppSubnet,
  DATA_CIDR,
  DataSubnet,
  EGRESS_TAG,
  PODS_CIDR,
  Probes,
  type ProbeResult,
  REGION,
  Results,
  SERVICES_CIDR,
  SmokeNetwork,
} from "./fixtures/egress-function.ts";

/**
 * GCP counterpart of the AWS VPC smoke: a custom-mode VPC with two regional
 * subnetworks (one with secondary ranges), a Cloud Router hosting Cloud NAT
 * on a reserved static IP, ingress/egress firewall rules (allow-internal,
 * deny-all egress overridden by a tagged tcp:443 allow), a custom route, and
 * an internal-only Effect-native Cloud Function using Direct VPC egress.
 * The function is driven through Pub/Sub, probes the internet, and records
 * the egress IP it observed — which must be the NAT's static address.
 */

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// Durable state: a subnet held by Cloud Run (below) stays resumable, so a
// later run's destroy drains it instead of orphaning it.
const sharedStack = Core.scratchStack(
  testOptions,
  "NetworkSmoke",
  "test/GCP/Compute/Network.smoke.test.ts",
);

// Cloud Run keeps the Direct VPC egress IPs it reserved in a subnet
// (`serverless-ipv4-*` addresses, purpose SERVERLESS) for up to 1-2 hours
// after the function is deleted, and the subnet cannot be deleted until they
// are released. Only that documented hold is tolerated: it fails the
// subnet's delete and skips the network's; every other failure surfaces.
// https://cloud.google.com/run/docs/configuring/vpc-direct-vpc
const HELD_BY_CLOUD_RUN =
  /already being used by \S+\/addresses\/serverless-ipv4-/;

const destroyStack = sharedStack.destroy().pipe(
  Effect.as([] as ReadonlyArray<string>),
  Effect.catch((error: unknown) =>
    error instanceof DestroyError &&
    error.failures.every(
      (failure) =>
        failure.resourceType === "GCP.Compute.Subnetwork" &&
        HELD_BY_CLOUD_RUN.test(Cause.pretty(failure.cause)),
    ) &&
    error.blocked.every(
      (blocked) => blocked.resourceType === "GCP.Compute.Network",
    )
      ? Effect.succeed([
          ...error.failures.map((failure) => failure.logicalId),
          ...error.blocked.map((blocked) => blocked.logicalId),
        ])
      : Effect.fail(error),
  ),
);

// private.googleapis.com — the canonical custom route for Private Google
// Access without the default internet route.
const PRIVATE_GOOGLE_APIS = "199.36.153.8/30";

interface StackOutputs {
  networkName: string;
  appSubnetName: string;
  dataSubnetName: string;
  routerName: string;
  natName: string;
  addressName: string;
  address: string;
  addressSelfLink: string;
  allowInternalName: string;
  denyEgressName: string;
  allowHttpsEgressName: string;
  routeName: string;
  functionName: string;
  functionUrl: string;
  bucketName: string;
  topicName: string;
}

let outputs: StackOutputs;

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

class ProbeNotRecorded extends Data.TaggedError("ProbeNotRecorded")<{
  readonly object: string;
}> {}

// Bounded wait until an out-of-band probe reports the resource gone.
const waitUntilGone = <E, R>(
  what: string,
  probe: Effect.Effect<boolean, E, R>,
) =>
  probe.pipe(
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.fail(new StillExists({ what })),
    ),
    Effect.retry({
      while: (e) => e instanceof StillExists,
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

const NAT_NAME = "smoke-egress";

const deployProgram = Effect.gen(function* () {
  const network = yield* SmokeNetwork;
  const appSubnet = yield* AppSubnet;
  const dataSubnet = yield* DataSubnet;

  const egressIp = yield* GCP.Compute.Address("EgressIp", {
    region: REGION,
    addressType: "EXTERNAL",
    description: "cloud nat egress",
  });

  const router = yield* GCP.Compute.Router("NatRouter", {
    region: REGION,
    network: network.networkName,
    description: "network smoke nat",
    nats: [
      {
        name: NAT_NAME,
        sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
        subnetworks: [{ name: appSubnet.subnetworkName }],
        natIpAllocateOption: "MANUAL_ONLY",
        natIps: [egressIp.selfLink.as<string>()],
        logConfig: { enable: true, filter: "ERRORS_ONLY" },
      },
    ],
  });

  const allowInternal = yield* GCP.Compute.Firewall("AllowInternal", {
    network: network.networkName,
    direction: "INGRESS",
    priority: 1000,
    sourceRanges: [APP_CIDR, DATA_CIDR, PODS_CIDR, SERVICES_CIDR],
    allowed: [{ protocol: "tcp" }, { protocol: "udp" }, { protocol: "icmp" }],
  });

  const denyEgress = yield* GCP.Compute.Firewall("DenyAllEgress", {
    network: network.networkName,
    direction: "EGRESS",
    priority: 65000,
    destinationRanges: ["0.0.0.0/0"],
    denied: [{ protocol: "all" }],
  });

  const allowHttpsEgress = yield* GCP.Compute.Firewall("AllowHttpsEgress", {
    network: network.networkName,
    direction: "EGRESS",
    priority: 1000,
    destinationRanges: ["0.0.0.0/0"],
    targetTags: [EGRESS_TAG],
    allowed: [{ protocol: "tcp", ports: ["443"] }],
  });

  const route = yield* GCP.Compute.Route("PrivateGoogleApis", {
    network: network.networkName,
    destRange: PRIVATE_GOOGLE_APIS,
    nextHopGateway: "default-internet-gateway",
    priority: 900,
    description: "private.googleapis.com",
  });

  const fn = yield* EgressFunction;
  const bucket = yield* Results;
  const topic = yield* Probes;

  return {
    networkName: network.networkName,
    appSubnetName: appSubnet.subnetworkName,
    dataSubnetName: dataSubnet.subnetworkName,
    routerName: router.routerName,
    natName: NAT_NAME,
    addressName: egressIp.addressName,
    address: egressIp.address,
    addressSelfLink: egressIp.selfLink,
    allowInternalName: allowInternal.firewallName,
    denyEgressName: denyEgress.firewallName,
    allowHttpsEgressName: allowHttpsEgress.firewallName,
    routeName: route.routeName,
    functionName: fn.name,
    functionUrl: fn.url,
    bucketName: bucket.bucketName,
    topicName: topic.name,
  };
});

const lastSegment = (value: string | undefined) => value?.split("/").at(-1);

describe.skipIf(!!process.env.FAST).sequential(
  "Network smoke",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:compute",
      "provider:gcp:cloudfunctions",
      "provider:gcp:pubsub",
      "provider:gcp:storage",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo("Network smoke: destroying previous stack");
        const held = yield* destroyStack;
        if (held.length > 0) {
          yield* Effect.logInfo(
            `Network smoke: still held by Cloud Run, reconciled in place: ${held.join(", ")}`,
          );
        }

        yield* Effect.logInfo("Network smoke: deploying stack");
        outputs = (yield* sharedStack.deploy(deployProgram)) as StackOutputs;
      }),
      { timeout: 900_000 },
    );

    afterAll(destroyStack, { timeout: 600_000 });

    test.provider(
      "custom-mode network, subnetworks, and route match the declaration",
      (_stack) =>
        Effect.gen(function* () {
          const { project } = yield* GcpEnvironment.current;

          const network = yield* compute.getNetworks({
            project,
            network: outputs.networkName,
          });
          expect(network.autoCreateSubnetworks).toBe(false);
          expect(network.routingConfig?.routingMode).toBe("REGIONAL");
          expect((network.subnetworks ?? []).map(lastSegment).sort()).toEqual(
            [outputs.appSubnetName, outputs.dataSubnetName].sort(),
          );

          const app = yield* compute.getSubnetworks({
            project,
            region: REGION,
            subnetwork: outputs.appSubnetName,
          });
          expect(app.ipCidrRange).toBe(APP_CIDR);
          expect(app.privateIpGoogleAccess).toBe(true);
          expect(lastSegment(app.network)).toBe(outputs.networkName);

          const data = yield* compute.getSubnetworks({
            project,
            region: REGION,
            subnetwork: outputs.dataSubnetName,
          });
          expect(data.ipCidrRange).toBe(DATA_CIDR);
          expect(
            (data.secondaryIpRanges ?? [])
              .map((r) => ({
                rangeName: r.rangeName,
                ipCidrRange: r.ipCidrRange,
              }))
              .sort((a, b) => a.rangeName!.localeCompare(b.rangeName!)),
          ).toEqual([
            { rangeName: "pods", ipCidrRange: PODS_CIDR },
            { rangeName: "services", ipCidrRange: SERVICES_CIDR },
          ]);

          const route = yield* compute.getRoutes({
            project,
            route: outputs.routeName,
          });
          expect(route.destRange).toBe(PRIVATE_GOOGLE_APIS);
          expect(route.priority).toBe(900);
          expect(lastSegment(route.network)).toBe(outputs.networkName);
          expect(lastSegment(route.nextHopGateway)).toBe(
            "default-internet-gateway",
          );
        }),
      {
        tags: ["provider:gcp", "provider:gcp:compute", "live"],
        timeout: 60_000,
      },
    );

    test.provider(
      "firewall: allow-internal ingress, deny-all egress, tagged tcp:443 override",
      (_stack) =>
        Effect.gen(function* () {
          const { project } = yield* GcpEnvironment.current;
          const get = (firewall: string) =>
            compute.getFirewalls({ project, firewall });

          const internal = yield* get(outputs.allowInternalName);
          expect(internal.direction).toBe("INGRESS");
          expect(lastSegment(internal.network)).toBe(outputs.networkName);
          expect([...(internal.sourceRanges ?? [])].sort()).toEqual(
            [APP_CIDR, DATA_CIDR, PODS_CIDR, SERVICES_CIDR].sort(),
          );
          expect(
            (internal.allowed ?? []).map((rule) => rule.IPProtocol).sort(),
          ).toEqual(["icmp", "tcp", "udp"]);

          const deny = yield* get(outputs.denyEgressName);
          expect(deny.direction).toBe("EGRESS");
          expect(deny.priority).toBe(65000);
          expect(deny.destinationRanges).toEqual(["0.0.0.0/0"]);
          expect(deny.denied?.map((rule) => rule.IPProtocol)).toEqual(["all"]);

          const https = yield* get(outputs.allowHttpsEgressName);
          expect(https.direction).toBe("EGRESS");
          expect(https.priority).toBe(1000);
          expect(https.targetTags).toEqual([EGRESS_TAG]);
          expect(https.allowed).toEqual([
            { IPProtocol: "tcp", ports: ["443"] },
          ]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:compute", "live"],
        timeout: 60_000,
      },
    );

    test.provider(
      "Cloud Router hosts NAT for the app subnet on the static address",
      (_stack) =>
        Effect.gen(function* () {
          const { project } = yield* GcpEnvironment.current;

          const router = yield* compute.getRouters({
            project,
            region: REGION,
            router: outputs.routerName,
          });
          expect(lastSegment(router.network)).toBe(outputs.networkName);
          expect(router.nats).toHaveLength(1);
          const nat = router.nats![0]!;
          expect(nat.name).toBe(outputs.natName);
          expect(nat.sourceSubnetworkIpRangesToNat).toBe("LIST_OF_SUBNETWORKS");
          expect(nat.subnetworks?.map((s) => lastSegment(s.name))).toEqual([
            outputs.appSubnetName,
          ]);
          expect(nat.natIpAllocateOption).toBe("MANUAL_ONLY");
          expect(nat.natIps?.map(lastSegment)).toEqual([outputs.addressName]);
          expect(nat.logConfig).toEqual({
            enable: true,
            filter: "ERRORS_ONLY",
          });

          const address = yield* compute.getAddresses({
            project,
            region: REGION,
            address: outputs.addressName,
          });
          expect(address.address).toBe(outputs.address);
          expect(address.addressType).toBe("EXTERNAL");
          expect(address.status).toBe("IN_USE");
        }),
      {
        tags: ["provider:gcp", "provider:gcp:compute", "live"],
        timeout: 60_000,
      },
    );

    test.provider(
      "function is internal-only and egresses directly into the app subnet",
      (_stack) =>
        Effect.gen(function* () {
          const fn = yield* cloudfunctions.getProjectsLocationsFunctions({
            name: outputs.functionName,
          });
          expect(fn.state).toBe("ACTIVE");
          expect(fn.serviceConfig?.ingressSettings).toBe("ALLOW_INTERNAL_ONLY");
          expect(fn.serviceConfig?.directVpcEgress).toBe(
            "VPC_EGRESS_ALL_TRAFFIC",
          );
          const nic = fn.serviceConfig?.directVpcNetworkInterface?.[0];
          expect(lastSegment(nic?.network)).toBe(outputs.networkName);
          expect(lastSegment(nic?.subnetwork)).toBe(outputs.appSubnetName);
          expect(nic?.tags).toEqual([EGRESS_TAG]);

          // Internal-only ingress: the public URL refuses outside callers.
          const response = yield* HttpClient.get(outputs.functionUrl);
          expect([403, 404]).toContain(response.status);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:compute", "live"],
        timeout: 60_000,
      },
    );

    test.provider(
      "a Pub/Sub-driven probe egresses through Cloud NAT and the firewall",
      (_stack) =>
        Effect.gen(function* () {
          const published = yield* pubsub.publishProjectsTopics({
            topic: outputs.topicName,
            body: { messages: [{ data: btoa("probe") }] },
          });
          const messageId = published.messageIds?.[0];
          expect(messageId).toEqual(expect.any(String));
          const object = `probe-${messageId}`;

          // Cold start + Direct VPC egress interface attach + push delivery.
          const probe: ProbeResult = yield* storage
            .getObjects({ bucket: outputs.bucketName, object })
            .pipe(
              Effect.map((found): ProbeResult =>
                Object.fromEntries(
                  Object.entries(found.metadata ?? {}).filter(
                    (entry): entry is [string, string] =>
                      entry[1] !== undefined,
                  ),
                ),
              ),
              Effect.catchTag("NotFound", () =>
                Effect.fail(new ProbeNotRecorded({ object })),
              ),
              Effect.retry({
                while: (e) => e._tag === "ProbeNotRecorded",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(36),
                ]),
              }),
            );

          expect(probe.ipError).toBeUndefined();
          // The public IP the internet saw is the NAT's static address.
          expect(probe.ip).toBe(outputs.address);
          // tcp:80 falls through to the deny-all egress rule.
          expect(probe.port80Blocked).toBe("true");
        }),
      {
        tags: ["provider:gcp", "provider:gcp:compute", "live"],
        timeout: 300_000,
      },
    );

    test.provider(
      "destroy removes the function, NAT router, firewalls, route, subnets, and network",
      (_stack) =>
        Effect.gen(function* () {
          const { project } = yield* GcpEnvironment.current;
          const held = yield* destroyStack;
          // Only the function's egress subnet (and its network) may linger.
          expect(
            held.every((id) => id === "AppSubnet" || id === "SmokeNetwork"),
          ).toBe(true);
          if (held.includes("AppSubnet")) {
            // Out-of-band: the only users of the subnet are Cloud Run's
            // serverless IP reservations.
            const addresses = yield* compute.listAddresses({
              project,
              region: REGION,
              filter: `subnetwork eq .*/subnetworks/${outputs.appSubnetName}$`,
            });
            expect(addresses.items?.length ?? 0).toBeGreaterThan(0);
            for (const address of addresses.items ?? []) {
              expect(address.purpose).toBe("SERVERLESS");
              expect(address.name).toMatch(/^serverless-ipv4-/);
            }
          }

          const notFound = () => Effect.succeed(true);

          yield* waitUntilGone(
            "function",
            cloudfunctions
              .getProjectsLocationsFunctions({
                name: outputs.functionName,
              })
              .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
          );
          yield* waitUntilGone(
            "router",
            compute
              .getRouters({
                project,
                region: REGION,
                router: outputs.routerName,
              })
              .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
          );
          yield* waitUntilGone(
            "address",
            compute
              .getAddresses({
                project,
                region: REGION,
                address: outputs.addressName,
              })
              .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
          );
          for (const firewall of [
            outputs.allowInternalName,
            outputs.denyEgressName,
            outputs.allowHttpsEgressName,
          ]) {
            yield* waitUntilGone(
              `firewall ${firewall}`,
              compute
                .getFirewalls({ project, firewall })
                .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
            );
          }
          yield* waitUntilGone(
            "route",
            compute
              .getRoutes({ project, route: outputs.routeName })
              .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
          );
          for (const subnetwork of [
            ...(held.includes("AppSubnet") ? [] : [outputs.appSubnetName]),
            outputs.dataSubnetName,
          ]) {
            yield* waitUntilGone(
              `subnetwork ${subnetwork}`,
              compute
                .getSubnetworks({ project, region: REGION, subnetwork })
                .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
            );
          }
          if (!held.includes("SmokeNetwork")) {
            yield* waitUntilGone(
              "network",
              compute
                .getNetworks({ project, network: outputs.networkName })
                .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
            );
          }
          yield* waitUntilGone(
            "bucket",
            storage
              .getBuckets({ bucket: outputs.bucketName })
              .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
          );
          yield* waitUntilGone(
            "topic",
            pubsub
              .getProjectsTopics({ topic: outputs.topicName })
              .pipe(Effect.as(false), Effect.catchTag("NotFound", notFound)),
          );
        }),
      {
        tags: ["provider:gcp", "provider:gcp:compute", "live"],
        timeout: 600_000,
      },
    );
  },
);
