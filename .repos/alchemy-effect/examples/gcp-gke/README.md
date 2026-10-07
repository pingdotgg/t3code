# GCP GKE Example

A "guestbook" app on GKE Autopilot, fully TypeScript-driven — no YAML, no
`kubectl apply`, no Helm, no Google service accounts.

- [`src/infra.ts`](./src/infra.ts) — the shared infrastructure: a
  `GCP.Container.Cluster` with `autopilot: true` (Google provisions and
  scales the nodes; Workload Identity Federation is always on), a named
  Firestore Native database, and a namespace applied as a raw manifest via
  `Kubernetes.Manifest`.
- [`src/Api.ts`](./src/Api.ts) — an effectful `Kubernetes.Deployment` in the
  tagged form (`Api.make(props, impl)`): an Effect HTTP server bundled into a
  generated image (pushed to a per-workload Artifact Registry repository),
  exposed through an external load balancer, with a Firestore binding
  granted to the Deployment's Kubernetes ServiceAccount principal. Includes
  the typed `podTemplate` escape hatch.
- [`src/SeedJob.ts`](./src/SeedJob.ts) — an inline-effect one-shot
  `Kubernetes.Job` (`{ run }`) that seeds the guestbook when the Job is
  applied on deploy.
- [`alchemy.run.ts`](./alchemy.run.ts) — thin composition: yields the shared
  infra, the tagged `Api` (via `Effect.provide(ApiLive)`), an EXTERNAL
  nginx `Kubernetes.Deployment` (registry `image:` source), and the `SeedJob`.

## Bindings and IAM

GCP bindings on a GKE workload grant IAM directly to the workload's
Kubernetes ServiceAccount (KSA) through
[Workload Identity Federation for GKE](https://cloud.google.com/kubernetes-engine/docs/concepts/workload-identity):

```
principal://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<PROJECT>.svc.id.goog/subject/ns/guestbook/sa/<ksa>
```

Inside the pod, the GKE metadata server hands out tokens for that principal,
so the bundled program authenticates with no keys and no Google service
account.

| Workload  | Binding                                                                  | IAM granted to the workload's KSA principal                          |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `Api`     | `GCP.Firestore.ReadWriteDatabase(EntriesDatabase)` + `ReadWriteDatabaseHttp` | `roles/datastore.user` on the project, conditioned to the database |
| `SeedJob` | `GCP.Firestore.WriteDatabase(EntriesDatabase)` + `WriteDatabaseHttp`     | `roles/datastore.user` on the project, conditioned to the database   |
| `Web`     | —                                                                        | —                                                                    |

Firestore databases have no resource-level IAM policy, so the grant is
project-level under an IAM Condition on the database name. It can take a
few minutes to propagate after the first deploy; the Job retries with
backoff and the API answers `500` until then. Removing a binding revokes its
grant on the next deploy; destroying a workload revokes all of them.

To run a workload as an existing Google service account instead, set
`identity: { gcpServiceAccount: "<gsa-email>" }` on it: Alchemy annotates the
KSA, grants its principal `roles/iam.workloadIdentityUser` on the GSA, and
lands the binding grants on the GSA.

## Commands

```sh
bun install
bun run --filter gcp-gke deploy
bun run --filter gcp-gke destroy
```

Docker must be running (images are built and mirrored locally). The
Autopilot cluster takes ~5–10 minutes to provision.

## Try it

```sh
# outputs: apiUrl (note the :3000 — the load balancer listens on the Service port), webUrl
curl "$apiUrl/entries"                            # seeded by SeedJob
curl -X POST "$apiUrl/entries?author=you&message=hello"
curl "$apiUrl/entries/ada"
curl "$webUrl"                                    # external nginx deployment
```

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test --timeout 3000000
```

The test deploys the stack, checks the Firestore grants landed on both KSA
principals (project IAM policy, conditioned to the database), waits for the
seed entries, signs and reads back an entry through the API (and out of band
in Firestore), fetches the nginx page, then destroys the stack and checks the
grants are revoked, no load balancer is left behind, and the cluster and
database are gone.

## Optional Inspection

To inspect the cluster manually after deploy:

```sh
gcloud container clusters get-credentials <clusterId output> --region us-central1
kubectl get pods -n guestbook
```
