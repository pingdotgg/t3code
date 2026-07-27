import * as Lambda from "@/AWS/Lambda";
import * as RedshiftServerless from "@/AWS/RedshiftServerless";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "connect-handler.ts");

export class ServerlessConnectFunction extends Lambda.Function<Lambda.Function>()(
  "ServerlessConnectFunction",
) {}

export default ServerlessConnectFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const namespace = yield* RedshiftServerless.Namespace("ConnectNamespace", {
      namespaceName: "alchemy-test-rsconn-ns",
      dbName: "dev",
      adminUsername: "alchemyadmin",
      manageAdminPassword: true,
    });
    const workgroup = yield* RedshiftServerless.Workgroup("ConnectWorkgroup", {
      workgroupName: "alchemy-test-rsconn-wg",
      namespaceName: namespace.namespaceName,
      baseCapacity: 8,
      publiclyAccessible: false,
    });

    const connect = yield* RedshiftServerless.Connect(workgroup, {
      database: "dev",
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          // Mints fresh temporary credentials via
          // redshift-serverless:GetCredentials on every request.
          const info = yield* connect;
          return yield* HttpServerResponse.json({
            host: info.host,
            port: info.port,
            database: info.database,
            username: info.username,
            hasPassword: info.password !== undefined,
            ssl: info.ssl,
            urlScheme: Redacted.value(info.url).split("://")[0],
            expiresInFuture:
              info.expiration !== undefined &&
              info.expiration.getTime() > Date.now(),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(RedshiftServerless.ConnectHttp)),
);
