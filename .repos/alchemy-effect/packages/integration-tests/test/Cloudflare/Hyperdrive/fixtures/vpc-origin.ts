import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * A private Hyperdrive origin reached through Workers VPC: a local Postgres
 * exposed as a TCP VPC Service over a Cloudflare Tunnel. `cloudflared` runs
 * on the test machine with the tunnel's token (see the Workers VPC test in
 * `Hyperdrive.test.ts`), standing in for a connector inside a private
 * network such as an AWS VPC.
 */
export const VPC_ORIGIN_PORT = 15433;
export const VPC_ORIGIN_PASSWORD = "alchemy-vpc-origin";

/** Tunnel whose connector reaches the private network. */
export const VpcOriginTunnel = Cloudflare.Tunnel.Tunnel("HyperdriveVpcTunnel", {
  ingress: [{ service: "http_status:404" }],
});

/** TCP VPC Service that routes to Postgres through the tunnel. */
export const VpcOriginService = Effect.gen(function* () {
  const tunnel = yield* VpcOriginTunnel;
  return yield* Cloudflare.Connectivity.DirectoryService("HyperdriveVpcService", {
    type: "tcp",
    tcpPort: VPC_ORIGIN_PORT,
    appProtocol: "postgresql",
    // The test Postgres serves the image's self-signed snakeoil cert.
    tlsSettings: { certVerificationMode: "disabled" },
    host: { ipv4: "127.0.0.1", network: { tunnelId: tunnel.tunnelId } },
  });
});

/** The Hyperdrive Connection that egresses through the VPC Service. */
export const VpcOriginConnection = Effect.gen(function* () {
  const service = yield* VpcOriginService;
  return yield* Cloudflare.Hyperdrive.Connection("HyperdriveVpcConnection", {
    origin: {
      scheme: "postgres",
      serviceId: service.serviceId,
      database: "postgres",
      user: "postgres",
      password: Redacted.make(VPC_ORIGIN_PASSWORD),
    },
  });
});
