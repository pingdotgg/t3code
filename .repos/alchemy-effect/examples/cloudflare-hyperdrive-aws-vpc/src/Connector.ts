import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { ConnectorSecurityGroup, Network } from "./Database.ts";

/** The Cloudflare Tunnel that carries Hyperdrive's traffic into the VPC. */
export const Tunnel = Cloudflare.Tunnel.Tunnel("Tunnel", {
  ingress: [{ service: "http_status:404" }],
});

/**
 * Runs `cloudflared` inside the VPC on ECS Fargate. It dials out to
 * Cloudflare, so the VPC needs no inbound rules. The tunnel token is kept in
 * Secrets Manager and injected as `TUNNEL_TOKEN`.
 */
export const Connector = Effect.gen(function* () {
  const network = yield* Network;
  const securityGroup = yield* ConnectorSecurityGroup;
  const tunnel = yield* Tunnel;
  const token = yield* AWS.SecretsManager.Secret("TunnelToken", {
    secretString: tunnel.token,
  });
  const cluster = yield* AWS.ECS.Cluster("Cluster", {});
  return yield* AWS.ECS.Service("Cloudflared", {
    cluster,
    image: "cloudflare/cloudflared:latest",
    command: ["tunnel", "--no-autoupdate", "run"],
    secrets: { TUNNEL_TOKEN: token.secretArn },
    vpcId: network.vpcId,
    subnets: network.publicSubnetIds,
    securityGroups: [securityGroup.groupId],
    assignPublicIp: true,
  });
});
