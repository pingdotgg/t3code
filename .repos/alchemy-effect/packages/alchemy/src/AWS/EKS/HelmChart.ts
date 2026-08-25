import * as eks from "@distilled.cloud/aws/eks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { isResolved } from "../../Diff.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sha256Object } from "../../Util/sha256.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteObjects,
  reconcileObjects,
  resolveKindSpec,
  type KubernetesClusterConnection,
} from "./internal/client.ts";
import { renderHelmChart } from "./internal/helm.ts";
import type {
  KubernetesObjectDefinition,
  KubernetesObjectRef,
} from "./internal/objects.ts";
import {
  toConnection,
  type ClusterConnectionProps,
} from "./internal/podIdentity.ts";

export interface HelmChartProps {
  /**
   * Target EKS cluster the chart's objects are applied onto. Pass the
   * `AWS.EKS.Cluster` resource; the chart reads its `endpoint` /
   * `certificateAuthorityData` to reach the Kubernetes API.
   */
  cluster: ClusterConnectionProps;
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
  "AWS.EKS.HelmChart",
  HelmChartProps,
  {
    /** The name of the EKS cluster the chart is applied to. */
    clusterName: string;
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
 * Renders a Helm chart and converges its objects onto an `AWS.EKS.Cluster`
 * via server-side apply.
 *
 * The chart is rendered locally with the `helm` CLI (`helm template` —
 * install helm on the deploying machine, like Docker for image builds);
 * the rendered objects then flow through the same apply machinery as
 * `AWS.EKS.Manifest`: Alchemy owns the object lifecycle, corrects drift on
 * every deploy, prunes objects that drop out of the render, and deletes
 * everything on destroy. There is no in-cluster Helm release record and no
 * kubeconfig step — cluster access uses your AWS credentials.
 *
 * Helm install/upgrade hooks are not executed (objects are applied, not
 * `helm install`ed); charts that depend on hooks for correctness should be
 * installed with Helm directly.
 * @resource
 * @section Installing a Chart
 * @example Chart from a repository
 * ```typescript
 * const ingress = yield* AWS.EKS.HelmChart("IngressNginx", {
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
 * @example OCI chart
 * ```typescript
 * const karpenter = yield* AWS.EKS.HelmChart("Karpenter", {
 *   cluster,
 *   chart: "oci://public.ecr.aws/karpenter/karpenter",
 *   version: "1.0.6",
 *   namespace: "kube-system",
 * });
 * ```
 *
 * @example Local chart directory
 * ```typescript
 * const app = yield* AWS.EKS.HelmChart("App", {
 *   cluster,
 *   chart: "./charts/app",
 *   values: { image: { tag: "v1.2.3" } },
 * });
 * ```
 */
export const HelmChart = Resource<HelmChart>("AWS.EKS.HelmChart");

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

// Re-resolve a Kubernetes connection from the cluster name alone (used by
// delete, whose persisted attributes don't cache the endpoint/CA).
const describeConnection = Effect.fn(function* (clusterName: string) {
  const described = yield* eks
    .describeCluster({ name: clusterName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const cluster = described?.cluster;
  if (!cluster?.endpoint || !cluster.certificateAuthority?.data) {
    return undefined;
  }
  return {
    clusterName,
    endpoint: cluster.endpoint,
    certificateAuthorityData: cluster.certificateAuthority.data,
  } satisfies KubernetesClusterConnection;
});

/**
 * Charts commonly omit `metadata.namespace` and rely on the install
 * namespace. Server-side apply addresses objects by explicit path, so
 * inject the target namespace into namespaced objects that omit it
 * (resolving each kind's scope; cluster-scoped objects pass through).
 */
const injectNamespace = Effect.fn(function* (
  connection: KubernetesClusterConnection,
  objects: ReadonlyArray<KubernetesObjectDefinition>,
  namespace: string,
) {
  return yield* Effect.forEach(objects, (object) =>
    Effect.gen(function* () {
      if (object.metadata.namespace !== undefined) return object;
      const spec = yield* resolveKindSpec({ connection, input: object });
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
        stables: ["clusterName", "releaseName", "namespace"],
        // In-cluster objects have no AWS-side enumeration that attributes
        // them to alchemy; refresh happens per-instance through `read`.
        list: () => Effect.succeed([] as HelmChart["Attributes"][]),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          const releaseName = yield* resolveReleaseName(id, news, output);
          // Object identity is the (cluster, release, namespace) triple —
          // moving any of it means a different set of objects.
          if (
            output &&
            (olds?.cluster?.clusterName !== news.cluster?.clusterName ||
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
          const placed = yield* injectNamespace(
            connection,
            rendered,
            namespace,
          );
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
            connection,
            previousObjects: output?.objects ?? [],
            desiredObjects,
          });

          return {
            clusterName: news.cluster.clusterName,
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
          // The objects live in-cluster; if the cluster itself is gone, so
          // are they.
          const connection = yield* describeConnection(output.clusterName);
          if (!connection) return undefined;
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = yield* describeConnection(output.clusterName);
          // Cluster already destroyed — its objects went with it.
          if (!connection) return;
          yield* deleteObjects({ connection, objects: output.objects });
        }),
      };
    }),
  );
