import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Connector, Tunnel } from "./Connector.ts";
import { DB_NAME, DB_USER, Database, DbPassword } from "./Database.ts";

/**
 * A TCP VPC Service for the Aurora writer endpoint. `cloudflared` resolves
 * the hostname with the VPC's DNS, so the private endpoint works as-is.
 */
export const AuroraService = Effect.gen(function* () {
  const tunnel = yield* Tunnel;
  const connector = yield* Connector;
  const db = yield* Database;
  // Hyperdrive connects to the database when it is created, so the path
  // must be live first: wait for the writer instance and the connector.
  const hostname = Output.map(
    Output.all(db.cluster.endpoint, db.writer.dbInstanceArn, connector.serviceArn),
    ([endpoint]) => endpoint!,
  );
  return yield* Cloudflare.Connectivity.DirectoryService("AuroraService", {
    type: "tcp",
    tcpPort: 5432,
    appProtocol: "postgresql",
    host: {
      hostname,
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    },
    // Aurora's certificate is issued by the Amazon RDS CA, which Workers VPC
    // does not trust yet (custom CAs are not supported). The connection is
    // still TLS-encrypted.
    tlsSettings: { certVerificationMode: "disabled" },
  });
});

/** Hyperdrive egresses through the VPC Service to reach Aurora. */
export const Hyperdrive = Effect.gen(function* () {
  const service = yield* AuroraService;
  const password = yield* DbPassword;
  return yield* Cloudflare.Hyperdrive.Connection("Hyperdrive", {
    origin: {
      scheme: "postgres",
      serviceId: service.serviceId,
      database: DB_NAME,
      user: DB_USER,
      password: password.text,
    },
  });
});
