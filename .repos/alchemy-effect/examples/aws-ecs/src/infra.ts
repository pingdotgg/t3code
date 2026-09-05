import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

/**
 * Shared infrastructure for the orders app.
 *
 * Each export is an Effect that declares a resource. Resources are memoized
 * by logical id, so these can be yielded from the stack program AND from a
 * service's init effect (e.g. `Api` binds the table and cluster) and always
 * converge on the same single resource instance.
 */

/**
 * A dedicated VPC with two public subnets (one per AZ — an internet-facing
 * ALB requires two AZs). No NAT: services run in the public subnets with
 * `assignPublicIp: true` so they can pull their images from ECR.
 */
export const OrdersNetwork = AWS.EC2.Network("OrdersNetwork", {
  cidrBlock: "10.61.0.0/16",
  availabilityZones: 2,
});

/** The ECS cluster every service and one-shot task in this app runs on. */
export const OrdersCluster = AWS.ECS.Cluster("OrdersCluster", {});

/** The orders table. Items are keyed `pk = order#<id>`. */
export const OrdersTable = AWS.DynamoDB.Table("OrdersTable", {
  partitionKey: "pk",
  attributes: { pk: "S" },
});

/**
 * The SHARED Application Load Balancer, owned at the stack level by neither
 * service. `Api` and `Web` each attach their own listener rules + target
 * groups to the single HTTP listener; requests no rule matches hit the
 * listener's 404 default action. Destroying one service removes only its
 * rules and target groups — the ALB and listener are untouched.
 */
export const OrdersIngress = Effect.gen(function* () {
  const network = yield* OrdersNetwork;

  const securityGroup = yield* AWS.EC2.SecurityGroup("AlbSecurityGroup", {
    vpcId: network.vpcId,
    description: "HTTP ingress for the shared orders ALB",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 80,
        toPort: 80,
        cidrIpv4: "0.0.0.0/0",
      },
    ],
  });

  const alb = yield* AWS.ELBv2.LoadBalancer("OrdersAlb", {
    type: "application",
    scheme: "internet-facing",
    subnets: network.publicSubnetIds,
    securityGroups: [securityGroup.groupId],
  });

  const listener = yield* AWS.ELBv2.Listener("OrdersHttpListener", {
    loadBalancerArn: alb.loadBalancerArn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [
      {
        type: "fixedResponse",
        statusCode: "404",
        contentType: "text/plain",
        messageBody: "no route",
      },
    ],
  });

  return { alb, listener };
});
