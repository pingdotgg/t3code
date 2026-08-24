import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * End-to-end fixture for `AWS.EKS.Deployment`: an Effect HTTP server deployed
 * as a Kubernetes Deployment + LoadBalancer Service on an EKS cluster.
 *
 * - The target cluster is deployed by the test's phase-1 program and referenced
 *   here via `AWS.EKS.Cluster.ref("EksHostCluster")` (props are an Effect).
 *   Refs resolve from stack state, giving the Deployment the cluster endpoint +
 *   CA at deploy — the reconciler applies the Deployment/Service via
 *   server-side apply against it.
 * - The DynamoDB `Table` is yielded inline (a plain Resource, safe to nest) and
 *   bound via `PutItem`. The binding lands `dynamodb:PutItem` IAM on the
 *   generated pod-identity role and injects the table name into the pod. At
 *   runtime the pod resolves credentials through the EKS Pod Identity
 *   container-credentials chain (`Credentials.fromChain()` in the bootstrap).
 * - `/put?id=x` writes an item so the test can prove the binding worked by
 *   reading it back out-of-band; `/health` gates readiness.
 */
export default class EksHostApi extends AWS.EKS.Deployment<EksHostApi>()(
  "EksHostApi",
  Effect.gen(function* () {
    const cluster = yield* AWS.EKS.Cluster.ref("EksHostCluster");
    return {
      main: import.meta.url,
      cluster,
      port: 3000,
      serviceType: "LoadBalancer" as const,
    };
  }),
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("EksHostTable", {
      partitionKey: "pk",
      attributes: { pk: "S" },
    });
    const putItem = yield* AWS.DynamoDB.PutItem(table);
    const TableName = yield* table.tableName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://eks-host");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/put") {
          const id = url.searchParams.get("id") ?? "default";
          yield* putItem({ Item: { pk: { S: id } } });
          return yield* HttpServerResponse.json({
            written: id,
            table: yield* TableName,
          });
        }
        return HttpServerResponse.text("eks deployment");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
) {}
