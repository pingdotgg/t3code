import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { isResolved } from "../Diff.ts";
import { hashDirectory } from "../Command/Memo.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { sha256Object } from "../Util/sha256.ts";
import {
  toConnection,
  type ClusterLike,
  type Connection,
} from "./Connection.ts";
import type { ClusterTransport } from "./ClusterAdapter.ts";
import {
  connectCluster,
  deleteObjects,
  reconcileObjects,
  resolveKindSpec,
} from "./internal/client.ts";
import { renderHelmChart } from "./internal/helm.ts";
import type {
  KubernetesObjectDefinition,
  KubernetesObjectRef,
} from "./internal/objects.ts";
import {
  connectionIdentity,
  connectionOfOutput,
  tryConnectionOf,
} from "./internal/workload.ts";
import type { Providers } from "./Providers.ts";

export interface HelmChartProps {
  /**
   * Target cluster the chart's objects are applied onto. Pass a managed
   * cluster resource (e.g. `AWS.EKS.Cluster`), a
   * `Kubernetes.KubeConfig(...)`, or a raw `Kubernetes.Connection`.
   */
  cluster: ClusterLike;
  /**
   * Chart reference: a repository chart name (used with {@link repo}, e.g.
   * `"ingress-nginx"`), an `oci://` registry reference, or a local chart
   * directory path.
   */
  chart: string;
  /**
   * Classic chart repository URL, e.g.
   * `https://kubernetes.github.io/ingress-nginx`. Not needed for `oci://`
   * references or local chart directories.
   */
  repo?: string;
  /**
   * Chart version to render. Pin this for repository/OCI charts — without
   * it, helm resolves the latest version at each deploy and the rendered
   * objects can drift between runs. Ignored for local chart directories.
   */
  version?: string;
  /**
   * Helm release name the chart's templates render with
   * (`.Release.Name`). If omitted, a deterministic name is derived from
   * the stack, stage, and logical ID.
   */
  releaseName?: string;
  /**
   * Kubernetes namespace the objects are rendered into
   * (`.Release.Namespace`; also injected as `metadata.namespace` on
   * namespaced objects the chart leaves namespace-less). The namespace
   * must already exist unless {@link createNamespace} is set.
   * @default "default"
   */
  namespace?: string;
  /**
   * Values passed to the chart — a literal object, the same shape as a
   * `values.yaml` file.
   */
  values?: Record<string, unknown>;
  /**
   * Render objects from the chart's `crds/` directory too.
   * @default true
   */
  includeCrds?: boolean;
  /**
   * Create (and own) the target Namespace object alongside the chart's
   * objects.
   * @default false
   */
  createNamespace?: boolean;
}

export interface HelmChart extends Resource<
  "Kubernetes.HelmChart",
  HelmChartProps,
  {
    /** The connection of the cluster the chart is applied to. */
    connection: Connection;
    /** The Helm release name the chart rendered with. */
    releaseName: string;
    /** The namespace the chart rendered into. */
    namespace: string;
    /** The chart reference that was rendered. */
    chart: string;
    /** The pinned chart version, when one was declared. */
    version: string | undefined;
    /** References to the applied Kubernetes objects. */
    objects: KubernetesObjectRef[];
    /** Content hash of the chart inputs (and local chart files). */
    code: {
      hash: string;
    };
  },
  {},
  Providers
> {}

/**
 * Renders a Helm chart and converges its objects onto any Kubernetes
 * cluster via server-side apply.
 *
 * The chart is rendered locally with the `helm` CLI (`helm template` —
 * install helm on the deploying machine, like Docker for image builds);
 * the rendered objects then flow through the same apply machinery as
 * `Kubernetes.Manifest`: Alchemy owns the object lifecycle, corrects drift
 * on every deploy, prunes objects that drop out of the render, and deletes
 * everything on destroy. There is no in-cluster Helm release record; the
 * target `cluster` can be a managed cluster resource (e.g.
 * `AWS.EKS.Cluster`) or any cluster your kubeconfig can reach.
 *
 * Helm lifecycle hooks (`helm.sh/hook`-annotated objects: install/upgrade/
 * delete hooks, tests) are neither executed nor applied — the chart is
 * rendered with `--no-hooks`, so they never enter the managed-object graph.
 * Charts that depend on hooks for correctness should be installed with Helm
 * directly.
 * ### Installing a Chart
 * **Example:** Chart from a repository
 * ```typescript
 * const ingress = yield* Kubernetes.HelmChart("IngressNginx", {
 *   cluster,
 *   chart: "ingress-nginx",
 *   repo: "https://kubernetes.github.io/ingress-nginx",
 *   version: "4.11.2",
 *   namespace: "ingress-nginx",
 *   createNamespace: true,
 *   values: {
 *     controller: { replicaCount: 2 },
 *   },
 * });
 * ```
 *
 * **Example:** OCI chart
 * ```typescript
 * const karpenter = yield* Kubernetes.HelmChart("Karpenter", {
 *   cluster,
 *   chart: "oci://public.ecr.aws/karpenter/karpenter",
 *   version: "1.0.6",
 *   namespace: "kube-system",
 * });
 * ```
 *
 * **Example:** Local chart directory
 * ```typescript
 * const app = yield* Kubernetes.HelmChart("App", {
 *   cluster,
 *   chart: "./charts/app",
 *   values: { image: { tag: "v1.2.3" } },
 * });
 * ```
 *
 * @resource
 */
export const HelmChart = Resource<HelmChart>("Kubernetes.HelmChart", {
  aliases: ["AWS.EKS.HelmChart"],
});

/**
 * Hash the chart identity: every render input, plus the chart directory's
 * content hash when `chart` is a local path (so editing a local chart is
 * visible to `diff` even though no prop changed).
 */
const computeChartHash = Effect.fn(function* (
  news: HelmChartProps,
  releaseName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const isLocalDir =
    !news.chart.startsWith("oci://") && (yield* fs.exists(news.chart));
  return yield* sha256Object({
    chart: news.chart,
    repo: news.repo,
    version: news.version,
    releaseName,
    namespace: news.namespace ?? "default",
    values: news.values,
    includeCrds: news.includeCrds ?? true,
    createNamespace: news.createNamespace ?? false,
    localChart: isLocalDir
      ? yield* hashDirectory({ cwd: news.chart })
      : undefined,
  });
});

const resolveReleaseName = (
  id: string,
  news: HelmChartProps,
  output: HelmChart["Attributes"] | undefined,
) =>
  Effect.suspend(() => {
    if (news.releaseName) return Effect.succeed(news.releaseName);
    if (output?.releaseName) return Effect.succeed(output.releaseName);
    return createPhysicalName({ id, lowercase: true });
  });

/**
 * Charts commonly omit `metadata.namespace` and rely on the install
 * namespace. Server-side apply addresses objects by explicit path, so
 * inject the target namespace into namespaced objects that omit it
 * (resolving each kind's scope; cluster-scoped objects pass through).
 */
const injectNamespace = Effect.fn(function* (
  transport: ClusterTransport,
  objects: ReadonlyArray<KubernetesObjectDefinition>,
  namespace: string,
) {
  return yield* Effect.forEach(objects, (object) =>
    Effect.gen(function* () {
      if (object.metadata.namespace !== undefined) return object;
      const spec = yield* resolveKindSpec({ transport, input: object });
      if (spec.scope === "Cluster") return object;
      return {
        ...object,
        metadata: { ...object.metadata, namespace },
      } satisfies KubernetesObjectDefinition;
    }),
  );
});

export const HelmChartProvider = () =>
  Provider.effect(
    HelmChart,
    Effect.gen(function* () {
      return {
        stables: ["connection", "releaseName", "namespace"],
        // In-cluster objects have no cloud-side enumeration that attributes
        // them to alchemy; refresh happens per-instance through `read`.
        list: () => Effect.succeed([] as HelmChart["Attributes"][]),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          const releaseName = yield* resolveReleaseName(id, news, output);
          const oldCluster = connectionIdentity(tryConnectionOf(olds?.cluster));
          const newCluster = connectionIdentity(tryConnectionOf(news.cluster));
          // Object identity is the (cluster, release, namespace) triple —
          // moving any of it means a different set of objects.
          if (
            output &&
            ((oldCluster !== undefined &&
              newCluster !== undefined &&
              oldCluster !== newCluster) ||
              output.releaseName !== releaseName ||
              output.namespace !== (news.namespace ?? "default"))
          ) {
            return { action: "replace" } as const;
          }
          if (output) {
            const hash = yield* computeChartHash(news, releaseName);
            if (hash !== output.code.hash) {
              return { action: "update" } as const;
            }
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const releaseName = yield* resolveReleaseName(id, news, output);
          const namespace = news.namespace ?? "default";
          const connection = toConnection(news.cluster);
          const transport = yield* connectCluster(connection);
          const hash = yield* computeChartHash(news, releaseName);

          yield* session.note(
            `Rendering Helm chart ${news.chart}${news.version ? `@${news.version}` : ""}...`,
          );
          const rendered = yield* renderHelmChart({
            chart: news.chart,
            repo: news.repo,
            version: news.version,
            releaseName,
            namespace,
            values: news.values,
            includeCrds: news.includeCrds,
          });
          const placed = yield* injectNamespace(transport, rendered, namespace);
          const desiredObjects: Array<KubernetesObjectDefinition> =
            news.createNamespace && namespace !== "default"
              ? [
                  {
                    apiVersion: "v1",
                    kind: "Namespace",
                    metadata: { name: namespace },
                  },
                  ...placed,
                ]
              : [...placed];

          yield* session.note(
            `Applying ${String(desiredObjects.length)} objects from ${news.chart}...`,
          );
          const objects = yield* reconcileObjects({
            transport,
            previousObjects: output?.objects ?? [],
            desiredObjects,
          });

          return {
            connection,
            releaseName,
            namespace,
            chart: news.chart,
            version: news.version,
            objects: [...objects],
            code: { hash },
          };
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const connection = connectionOfOutput(output);
          if (!connection) return undefined;
          // The objects live in-cluster; if the cluster itself is gone, so
          // are they.
          const transport = yield* connectCluster(connection).pipe(
            Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!transport) return undefined;
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = connectionOfOutput(output);
          if (!connection) return;
          const transport = yield* connectCluster(connection).pipe(
            // Cluster already destroyed — its objects went with it.
            Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!transport) return;
          yield* deleteObjects({ transport, objects: output.objects });
        }),
      };
    }),
  );
