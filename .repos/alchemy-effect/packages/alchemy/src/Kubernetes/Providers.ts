import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { builtinAdapters } from "./BuiltinAdapters.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import { HelmChart, HelmChartProvider } from "./HelmChart.ts";
import { Job, JobProvider } from "./Job.ts";
import { Manifest, ManifestProvider } from "./Manifest.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Kubernetes",
) {}

/**
 * The Kubernetes provider layer: the cluster-agnostic workload providers
 * (`Deployment`, `Job`, `Manifest`, `HelmChart`) plus the built-in
 * cluster adapters (`kubeconfig`, `token`, `client-cert`, `exec`).
 *
 * Managed-cloud clusters need their platform's adapter alongside — e.g.
 * targeting an `AWS.EKS.Cluster` requires `AWS.providers()` in the same
 * stack:
 *
 * ```ts
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()),
 *   state: AWS.state(),
 * });
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Deployment, HelmChart, Job, Manifest]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DeploymentProvider(),
        HelmChartProvider(),
        JobProvider(),
        ManifestProvider(),
      ),
    ),
    // The built-in adapters are provideMerged (not just provided) so the
    // workloads' dynamic `findClusterAdapter` lookups see them in the
    // ambient stack context.
    Layer.provideMerge(builtinAdapters()),
    Layer.orDie,
  );
