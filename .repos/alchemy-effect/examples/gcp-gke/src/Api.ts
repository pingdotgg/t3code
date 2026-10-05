import * as GCP from "alchemy/GCP";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  EntriesDatabase,
  entryPath,
  GuestbookCluster,
  GuestbookNamespace,
} from "./infra.ts";

/**
 * The guestbook API: a `Kubernetes.Deployment` in the TAGGED form — the class
 * declares the deployment identity, and the default export is
 * `Api.make(props, impl)`: a Layer pairing the props with an init Effect
 * whose impl returns `{ fetch }`, bundled into a generated image
 * (`main: import.meta.url`). The Deployment synthesizes the Kubernetes
 * Deployment + Service + ServiceAccount (server-side apply) and an Artifact
 * Registry repository holding the image.
 *
 * The stack provides the Layer and yields the class (see `alchemy.run.ts`):
 *
 * ```typescript
 * const api = yield* Api;         // with Effect.provide(ApiLive)
 * ```
 *
 * `serviceType: "LoadBalancer"` has GKE provision an external passthrough
 * Network Load Balancer; `api.url` is the full URL INCLUDING the Service
 * port (`http://<ip>:3000` — Kubernetes maps `spec.ports[].port` 1:1 to the
 * cloud listener).
 *
 * Bindings work exactly as on Cloud Run:
 * - `GCP.Firestore.ReadWriteDatabase` grants `roles/datastore.user` —
 *   project-level, under an IAM Condition naming this database — directly
 *   to the Deployment's Kubernetes ServiceAccount principal
 *   (`principal://…/subject/ns/guestbook/sa/<ksa>`), and injects the
 *   database name into the pod. At runtime the pod's GKE metadata server
 *   hands out Workload Identity Federation tokens for that principal — no
 *   keys, no Google service account.
 *
 * `podTemplate` is the Kubernetes escape hatch: a literal deep-partial Pod
 * template merged into the synthesized one (objects merge recursively;
 * arrays and primitives replace).
 */
export class Api extends Kubernetes.Deployment<Api>()("Api") {}

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
      // Autopilot sizes nodes from requests (and pins limits to them).
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "250m", memory: "512Mi" },
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
    const db = yield* GCP.Firestore.ReadWriteDatabase(EntriesDatabase);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://guestbook");

        // GET /entries — list every entry.
        if (request.method === "GET" && url.pathname === "/entries") {
          const page = yield* db.list("entries", { pageSize: 300 });
          const entries = page.documents.map((document) => ({
            id: document.name.split("/").pop(),
            author: document.fields.author,
            message: document.fields.message,
          }));
          return yield* HttpServerResponse.json({
            count: entries.length,
            entries,
          });
        }

        // GET /entries/<id> — read one entry.
        const match = url.pathname.match(/^\/entries\/([^/]+)$/);
        if (request.method === "GET" && match) {
          const document = yield* db.get(entryPath(match[1]!));
          if (document === undefined) {
            return yield* HttpServerResponse.json(
              { error: "not found" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({
            id: match[1],
            author: document.fields.author,
            message: document.fields.message,
          });
        }

        // POST /entries?author=ada&message=hi — sign the guestbook.
        if (request.method === "POST" && url.pathname === "/entries") {
          const author = url.searchParams.get("author") ?? "anonymous";
          const message = url.searchParams.get("message") ?? "";
          const id = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
          yield* db.set(entryPath(id), { author, message });
          return yield* HttpServerResponse.json({ id, author, message });
        }

        // Everything else — including "/" health probes.
        return yield* HttpServerResponse.json({
          ok: true,
          service: "guestbook-api",
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp)),
);
