import * as GCP from "@/GCP";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

export const REGION = "us-central1";
/** Network tag carried by the function; only it may egress on tcp:443. */
export const EGRESS_TAG = "smoke-egress";
export const APP_CIDR = "10.40.0.0/24";
export const DATA_CIDR = "10.40.1.0/24";
export const PODS_CIDR = "10.44.0.0/16";
export const SERVICES_CIDR = "10.48.0.0/20";

/** Custom-mode VPC: no auto-created subnetworks, regional dynamic routing. */
// Fixed names: Cloud Run holds the app subnet (and so the network) for
// 1-2 hours after the function is deleted, so a later run must re-adopt
// the held network instead of creating another one — the project allows
// only 5 VPC networks.
export const SmokeNetwork = GCP.Compute.Network("SmokeNetwork", {
  networkName: "alchemy-network-smoke",
  autoCreateSubnetworks: false,
  routingMode: "REGIONAL",
  description: "network smoke",
});

/** Subnet the function egresses from (Direct VPC egress). */
export const AppSubnet = Effect.gen(function* () {
  const network = yield* SmokeNetwork;
  return yield* GCP.Compute.Subnetwork("AppSubnet", {
    subnetworkName: "alchemy-network-smoke-app",
    region: REGION,
    network: network.networkName,
    ipCidrRange: APP_CIDR,
    privateIpGoogleAccess: true,
  });
});

/** Second subnet with GKE-style secondary ranges. */
export const DataSubnet = Effect.gen(function* () {
  const network = yield* SmokeNetwork;
  return yield* GCP.Compute.Subnetwork("DataSubnet", {
    region: REGION,
    network: network.networkName,
    ipCidrRange: DATA_CIDR,
    secondaryIpRanges: [
      { rangeName: "pods", ipCidrRange: PODS_CIDR },
      { rangeName: "services", ipCidrRange: SERVICES_CIDR },
    ],
  });
});

/** Results the function writes after each probe. */
export const Results = GCP.Storage.Bucket("EgressResults", {
  forceDestroy: true,
});
/** Topic pushed to the (internal-only) function. */
export const Probes = GCP.PubSub.Topic("EgressProbes", {});

/**
 * Probe outcome, stored as the result object's custom metadata:
 * `ip` (public IP the echo service saw — the NAT address) or `ipError`,
 * and `port80Blocked` (`"true"` when plain HTTP egress was dropped).
 */
export type ProbeResult = Record<string, string>;

const IP_ECHO = "api.ipify.org";

/**
 * Private Cloud Function: internal-only ingress, all egress through the
 * VPC (`AppSubnet`) → firewall → Cloud NAT. Each Pub/Sub message triggers
 * an outbound probe; the result lands in {@link Results} as
 * `probe-{messageId}` (outcome in its custom metadata). Deployed from
 * {@link ../Network.smoke.test.ts}.
 */
export default class EgressFunction extends GCP.CloudFunctions.Function<EgressFunction>()(
  "EgressFunction",
  Effect.gen(function* () {
    const network = yield* SmokeNetwork;
    const subnet = yield* AppSubnet;
    return {
      main: import.meta.url,
      location: REGION,
      serviceConfig: {
        timeoutSeconds: 180,
        maxInstanceCount: 1,
        ingressSettings: "ALLOW_INTERNAL_ONLY",
        directVpcEgress: "VPC_EGRESS_ALL_TRAFFIC",
        directVpcNetworkInterface: [
          {
            network: network.networkName,
            subnetwork: subnet.subnetworkName,
            tags: [EGRESS_TAG],
          },
        ],
      },
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* Results;
    const putObject = yield* GCP.Storage.PutObject(bucket);
    const http = yield* HttpClient.HttpClient;

    const probe = Effect.gen(function* () {
      const ip = yield* http.get(`https://${IP_ECHO}?format=json`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((body): ProbeResult => ({
          ip: String((body as { ip?: string }).ip),
        })),
        Effect.timeout(Duration.seconds(15)),
        // Cloud NAT programs a fresh Direct VPC egress instance
        // asynchronously (tens of seconds after cold start).
        Effect.retry({
          schedule: Schedule.spaced("5 seconds"),
          times: 7,
        }),
        Effect.catch((error) =>
          Effect.succeed<ProbeResult>({
            ipError: `${String(error)} ${String((error as { cause?: unknown }).cause ?? "")}`,
          }),
        ),
      );
      // Runs after NAT is proven to work, so a failure here is the deny-all
      // egress rule dropping tcp:80 (the request can only time out).
      const port80Blocked = yield* http.get(`http://${IP_ECHO}`).pipe(
        Effect.timeout(Duration.seconds(8)),
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      );
      return { ...ip, port80Blocked: String(port80Blocked) } as ProbeResult;
    });

    yield* GCP.PubSub.consumeTopicMessages(Probes, (messages) =>
      messages.pipe(
        Stream.runForEach(({ message }) =>
          probe.pipe(
            Effect.flatMap((result) =>
              putObject({
                name: `probe-${message.messageId}`,
                body: "probe",
                metadata: result,
              }),
            ),
            Effect.orDie,
          ),
        ),
      ),
    );

    return {};
  }).pipe(
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.CloudFunctions.TopicEventSource),
    Effect.provide(FetchHttpClient.layer),
  ),
) {}
