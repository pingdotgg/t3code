import * as Lambda from "@/AWS/Lambda";
import * as Redshift from "@/AWS/Redshift";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "connect-handler.ts");

export class RedshiftConnectFunction extends Lambda.Function<Lambda.Function>()(
  "RedshiftConnectFunction",
) {}

const summarize = (info: Redshift.ClusterConnectionInfo) => ({
  host: info.host,
  port: info.port,
  database: info.database,
  username: info.username,
  hasPassword: info.password !== undefined,
  ssl: info.ssl,
  urlScheme: Redacted.value(info.url).split("://")[0],
  expiresInFuture:
    info.expiration !== undefined && info.expiration.getTime() > Date.now(),
});

export default RedshiftConnectFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const cluster = yield* Redshift.Cluster("ConnectCluster", {
      clusterIdentifier: "alchemy-test-redshift-connect",
      manageMasterPassword: true,
      publiclyAccessible: false,
    });

    // Default strategy: the database user is mapped 1:1 to the Lambda's IAM
    // identity via redshift:GetClusterCredentialsWithIAM.
    const connectIam = yield* Redshift.Connect(cluster);
    // Named-user strategy: redshift:GetClusterCredentials with AutoCreate.
    const connectDbUser = yield* Redshift.Connect(cluster, {
      dbUser: "alchemy_etl",
      autoCreate: true,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          const info = yield* connectIam;
          return yield* HttpServerResponse.json(summarize(info));
        }
        if (request.method === "GET" && pathname === "/info-dbuser") {
          const info = yield* connectDbUser;
          return yield* HttpServerResponse.json(summarize(info));
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Redshift.ConnectHttp)),
);
