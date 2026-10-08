import * as GCP from "alchemy/GCP";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";

/**
 * Shared infrastructure for the guestbook app.
 *
 * Each export is an Effect that declares a resource. Resources are memoized
 * by logical id, so these can be yielded from the stack program AND from a
 * workload's props/init effect (e.g. `Api` targets the cluster and binds the
 * database) and always converge on the same single resource instance.
 */

/**
 * The GKE cluster every workload in this app runs on. `autopilot: true` is
 * GKE Autopilot: Google provisions and scales the nodes from the pods'
 * resource requests — no node pools to manage. Autopilot clusters are
 * regional and always have Workload Identity Federation enabled, which is
 * how the workloads' bindings authenticate.
 */
export const GuestbookCluster = GCP.Container.Cluster("GuestbookCluster", {
  // Autopilot needs a region; the Cluster default is the zone `us-central1-a`.
  location: "us-central1",
  autopilot: true,
  releaseChannel: "REGULAR",
});

/**
 * The guestbook database: a named Firestore database in Native mode.
 * Entries are documents at `entries/<id>`.
 */
export const EntriesDatabase = GCP.Firestore.Database("EntriesDatabase", {
  type: "FIRESTORE_NATIVE",
});

/**
 * The `guestbook` namespace, applied as a RAW MANIFEST via `Kubernetes.Manifest`
 * (server-side apply) — a literal Kubernetes object. Workloads reference
 * `ns.name` so they deploy after the namespace exists.
 */
export const GuestbookNamespace = Effect.gen(function* () {
  const cluster = yield* GuestbookCluster;
  return yield* Kubernetes.Manifest("GuestbookNamespace", {
    cluster,
    manifest: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "guestbook",
        labels: { "app.kubernetes.io/part-of": "guestbook" },
      },
    },
  });
});

/** The document path of one guestbook entry. */
export const entryPath = (id: string) => `entries/${id}`;
