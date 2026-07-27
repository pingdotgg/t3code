import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Region from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";
import type { SqlConnectionInfo } from "../Connection/internal.ts";
import { formatSqlConnectionUrl } from "../Connection/internal.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import { Connect, connectEnvPrefix, type ConnectOptions } from "./Connect.ts";

const DSQL_PORT = 5432;

/**
 * IAM-token implementation of {@link Connect}. At deploy time it grants
 * `dsql:DbConnect` (or `dsql:DbConnectAdmin`) on the cluster to the host
 * Function and publishes the endpoint as `DSQL_{LOGICAL_ID}_HOST`; at runtime
 * it presigns a fresh auth token (client-side SigV4 — no API call) with the
 * Function's own credentials and formats the full connection descriptor.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    // Captured at layer build so the runtime callable only requires
    // RuntimeContext — the presign resolves credentials lazily from the
    // service on every mint, so refreshed execution-role creds are honored.
    const services = yield* Effect.context<
      Credentials.Credentials | Region.Region
    >();

    return Effect.fn(function* (cluster: Cluster, options?: ConnectOptions) {
      const Host = yield* cluster.endpoint;
      const admin = options?.admin ?? false;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const prefix = connectEnvPrefix(cluster.LogicalId);
          yield* host.bind`Allow(${host}, AWS.DSQL.Connect(${cluster}))`({
            env: {
              [`${prefix}_HOST`]: cluster.endpoint,
            },
            policyStatements: [
              {
                Effect: "Allow",
                Action: [admin ? "dsql:DbConnectAdmin" : "dsql:DbConnect"],
                Resource: [cluster.clusterArn],
              },
            ],
          });
        }
      }

      const username = admin ? "admin" : options?.username;
      const database = options?.database ?? "postgres";

      return Effect.gen(function* () {
        const host = yield* Host;
        if (!host) {
          return yield* Effect.die(
            `DSQL endpoint for '${cluster.LogicalId}' is not available yet`,
          );
        }
        const password = yield* generateDbAuthToken({
          service: "dsql",
          hostname: host,
          action: admin ? "DbConnectAdmin" : "DbConnect",
        }).pipe(Effect.provideContext(services));
        return {
          host,
          port: DSQL_PORT,
          database,
          username,
          password,
          ssl: true,
          url: formatSqlConnectionUrl({
            host,
            port: DSQL_PORT,
            database,
            username,
            password,
            ssl: true,
          }),
        } satisfies SqlConnectionInfo;
      });
    });
  }),
);
