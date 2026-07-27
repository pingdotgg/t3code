import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

/**
 * Shared infrastructure for the guestbook app.
 *
 * Each export is an Effect that declares a resource. Resources are memoized
 * by logical id, so these can be yielded from the stack program AND from a
 * workload's props/init effect (e.g. `Api` targets the cluster and binds the
 * table) and always converge on the same single resource instance.
 */

/**
 * A dedicated VPC with two public subnets (one per AZ — an internet-facing
 * NLB requires two AZs). No NAT: Auto Mode nodes launch in the public
 * subnets so they can pull images from ECR.
 */
export const GuestbookNetwork = AWS.EC2.Network("GuestbookNetwork", {
  cidrBlock: "10.71.0.0/16",
  availabilityZones: 2,
});

/**
 * The EKS cluster every workload in this app runs on. `compute: "auto"` is
 * EKS Auto Mode in one prop: the provider creates and owns the cluster +
 * node IAM roles and enables managed compute, block storage, and elastic
 * load balancing — no nodegroups, no addons, no controllers to install.
 */
export const GuestbookCluster = Effect.gen(function* () {
  const network = yield* GuestbookNetwork;
  return yield* AWS.EKS.Cluster("GuestbookCluster", {
    compute: "auto",
    resourcesVpcConfig: {
      subnetIds: network.publicSubnetIds,
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
    },
  });
});

/** The guestbook table. Items are keyed `pk = entry#<id>`. */
export const EntriesTable = AWS.DynamoDB.Table("EntriesTable", {
  partitionKey: "pk",
  attributes: { pk: "S" },
});

/**
 * The `guestbook` namespace, applied as a RAW MANIFEST via `AWS.EKS.Manifest`
 * (server-side apply) — a literal Kubernetes object. Workloads reference
 * `ns.name` so they deploy after the namespace exists.
 */
export const GuestbookNamespace = Effect.gen(function* () {
  const cluster = yield* GuestbookCluster;
  return yield* AWS.EKS.Manifest("GuestbookNamespace", {
    cluster,
    manifest: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "guestbook",
        labels: { "app.kubernetes.io/part-of": "guestbook" },
      },
    },
  });
});
