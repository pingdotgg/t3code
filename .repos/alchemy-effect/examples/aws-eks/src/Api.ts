import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EntriesTable, GuestbookCluster, GuestbookNamespace } from "./infra.ts";

/**
 * The guestbook API: an `AWS.EKS.Deployment` in the TAGGED form — the class
 * declares the deployment identity, and the default export is
 * `Api.make(props, impl)`: a Layer pairing the props with an init Effect
 * whose impl returns `{ fetch }`, bundled into a generated image
 * (`main: import.meta.url`). The Deployment synthesizes the Kubernetes
 * Deployment + Service + ServiceAccount (server-side apply), a pod-identity
 * IAM role + PodIdentityAssociation, and an ECR repository.
 *
 * The stack provides the Layer and yields the class (see `alchemy.run.ts`):
 *
 * ```typescript
 * const api = yield* Api;         // with Effect.provide(ApiLive)
 * ```
 *
 * `serviceType: "LoadBalancer"` has Auto Mode's built-in controller
 * provision an internet-facing NLB; `api.url` is the full URL INCLUDING the
 * Service port (`http://<nlb-hostname>:3000` — Kubernetes maps
 * `spec.ports[].port` 1:1 to the cloud listener).
 *
 * Bindings work exactly as on Lambda and ECS:
 * - `AWS.DynamoDB.PutItem` / `GetItem` / `Scan` land IAM on the generated
 *   pod-identity role and inject the table name into the pod. At runtime the
 *   pod resolves credentials through the EKS Pod Identity
 *   container-credentials chain — no static keys, no IRSA annotations.
 *
 * `podTemplate` is the Kubernetes escape hatch: a literal deep-partial Pod
 * template merged into the synthesized one (objects merge recursively;
 * arrays and primitives replace).
 */
export class Api extends AWS.EKS.Deployment<Api>()("Api") {}

export default Api.make(
  // Props are themselves an Effect so they can reference shared resources.
  Effect.gen(function* () {
    const cluster = yield* GuestbookCluster;
    const ns = yield* GuestbookNamespace;
    return {
      cluster,
      main: import.meta.url,
      // Reference the Manifest's attribute (not a bare string) so the
      // Deployment depends on — and deploys after — the namespace.
      namespace: ns.name,
      port: 3000,
      replicas: 2,
      serviceType: "LoadBalancer" as const,
      resources: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "500m", memory: "256Mi" },
      },
      // Kubernetes escape hatch: tune the synthesized Pod template with a
      // literal deep-partial object merged onto it.
      podTemplate: {
        metadata: {
          annotations: {
            "prometheus.io/scrape": "true",
            "prometheus.io/port": "3000",
          },
        },
        spec: { terminationGracePeriodSeconds: 30 },
      },
    };
  }),
  Effect.gen(function* () {
    const table = yield* EntriesTable;

    const putItem = yield* AWS.DynamoDB.PutItem(table);
    const getItem = yield* AWS.DynamoDB.GetItem(table);
    const scan = yield* AWS.DynamoDB.Scan(table);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://guestbook");

        // GET /entries — list everything in the table.
        if (request.method === "GET" && url.pathname === "/entries") {
          const result = yield* scan({});
          const entries = (result.Items ?? []).map((item) => ({
            id: item.pk?.S?.replace(/^entry#/, ""),
            author: item.author?.S,
            message: item.message?.S,
          }));
          return yield* HttpServerResponse.json({
            count: entries.length,
            entries,
          });
        }

        // GET /entries/<id> — read one entry.
        const match = url.pathname.match(/^\/entries\/([^/]+)$/);
        if (request.method === "GET" && match) {
          const result = yield* getItem({
            Key: { pk: { S: `entry#${match[1]}` } },
          });
          if (!result.Item) {
            return yield* HttpServerResponse.json(
              { error: "not found" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({
            id: match[1],
            author: result.Item.author?.S,
            message: result.Item.message?.S,
          });
        }

        // POST /entries?author=ada&message=hi — sign the guestbook.
        if (request.method === "POST" && url.pathname === "/entries") {
          const author = url.searchParams.get("author") ?? "anonymous";
          const message = url.searchParams.get("message") ?? "";
          const id = yield* Effect.sync(() =>
            crypto.randomUUID().slice(0, 8),
          );
          yield* putItem({
            Item: {
              pk: { S: `entry#${id}` },
              author: { S: author },
              message: { S: message },
            },
          });
          return yield* HttpServerResponse.json({ id, author, message });
        }

        // Everything else — including "/" health probes.
        return yield* HttpServerResponse.json({
          ok: true,
          service: "guestbook-api",
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.DynamoDB.PutItemHttp,
        AWS.DynamoDB.GetItemHttp,
        AWS.DynamoDB.ScanHttp,
      ),
    ),
  ),
);
