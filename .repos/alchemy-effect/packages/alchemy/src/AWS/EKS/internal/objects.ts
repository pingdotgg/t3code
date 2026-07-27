/**
 * Internal Kubernetes object model + ordering/path helpers powering
 * `AWS.EKS.Manifest` and the EKS platforms (`Deployment`, `Job`). Not part of
 * the public surface — the public manifest shape is the literal
 * `KubernetesManifest` on `AWS.EKS.Manifest`.
 */

export interface KubernetesObjectMetadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export type KubernetesObjectDefinition = {
  apiVersion: string;
  kind: string;
  metadata: KubernetesObjectMetadata;
} & Record<string, unknown>;

export interface KubernetesObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

export interface KubernetesObjectBinding {
  type: "kubernetes-object";
  object: KubernetesObjectDefinition;
}

export type KubernetesObjectScope = "Cluster" | "Namespaced";

export interface KubernetesObjectKindSpec {
  plural: string;
  scope: KubernetesObjectScope;
  applyRank: number;
}

/** Apply rank for kinds not in the static table (applied last, deleted first). */
export const DEFAULT_APPLY_RANK = 100;

const supportedKinds: Record<string, KubernetesObjectKindSpec> = {
  "v1/Namespace": {
    plural: "namespaces",
    scope: "Cluster",
    applyRank: 10,
  },
  // CRDs apply right after namespaces so a chart's custom resources
  // (default rank 100) always find their definition registered.
  "apiextensions.k8s.io/v1/CustomResourceDefinition": {
    plural: "customresourcedefinitions",
    scope: "Cluster",
    applyRank: 15,
  },
  "v1/ServiceAccount": {
    plural: "serviceaccounts",
    scope: "Namespaced",
    applyRank: 20,
  },
  "v1/ConfigMap": {
    plural: "configmaps",
    scope: "Namespaced",
    applyRank: 30,
  },
  "v1/Secret": {
    plural: "secrets",
    scope: "Namespaced",
    applyRank: 30,
  },
  "v1/Service": {
    plural: "services",
    scope: "Namespaced",
    applyRank: 40,
  },
  "apps/v1/Deployment": {
    plural: "deployments",
    scope: "Namespaced",
    applyRank: 50,
  },
  "apps/v1/StatefulSet": {
    plural: "statefulsets",
    scope: "Namespaced",
    applyRank: 50,
  },
  "apps/v1/DaemonSet": {
    plural: "daemonsets",
    scope: "Namespaced",
    applyRank: 50,
  },
  "batch/v1/Job": {
    plural: "jobs",
    scope: "Namespaced",
    applyRank: 60,
  },
  "batch/v1/CronJob": {
    plural: "cronjobs",
    scope: "Namespaced",
    applyRank: 60,
  },
  "v1/Pod": {
    plural: "pods",
    scope: "Namespaced",
    applyRank: 60,
  },
};

const objectTypeKey = (
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">,
) => `${input.apiVersion}/${input.kind}`;

/** Look up the static kind table; `undefined` for kinds needing discovery. */
export const lookupKubernetesKindSpec = (
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">,
): KubernetesObjectKindSpec | undefined => supportedKinds[objectTypeKey(input)];

export const getKubernetesKindSpec = (
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">,
) => {
  const spec = lookupKubernetesKindSpec(input);
  if (!spec) {
    throw new Error(
      `Unsupported Kubernetes object ${input.apiVersion}/${input.kind}`,
    );
  }
  return spec;
};

const applyRankOf = (input: Pick<KubernetesObjectRef, "apiVersion" | "kind">) =>
  lookupKubernetesKindSpec(input)?.applyRank ?? DEFAULT_APPLY_RANK;

export const toKubernetesObjectRef = (
  object: KubernetesObjectDefinition,
): KubernetesObjectRef => ({
  apiVersion: object.apiVersion,
  kind: object.kind,
  name: object.metadata.name,
  namespace: object.metadata.namespace,
});

export const kubernetesObjectKey = (
  input: Pick<
    KubernetesObjectRef,
    "apiVersion" | "kind" | "name" | "namespace"
  >,
) =>
  [
    input.apiVersion,
    input.kind,
    input.namespace ?? "_cluster",
    input.name,
  ].join("/");

const compareRefs = (a: KubernetesObjectRef, b: KubernetesObjectRef) =>
  kubernetesObjectKey(a).localeCompare(kubernetesObjectKey(b));

export const sortObjectsForApply = (
  objects: ReadonlyArray<KubernetesObjectDefinition>,
) =>
  [...objects].sort(
    (a, b) =>
      applyRankOf(a) - applyRankOf(b) ||
      compareRefs(toKubernetesObjectRef(a), toKubernetesObjectRef(b)),
  );

export const sortRefsForDelete = (
  objects: ReadonlyArray<KubernetesObjectRef>,
) =>
  [...objects].sort(
    (a, b) => applyRankOf(b) - applyRankOf(a) || compareRefs(a, b),
  );

export const chunkByApplyRank = (
  objects: ReadonlyArray<KubernetesObjectDefinition>,
) => {
  const chunks: KubernetesObjectDefinition[][] = [];

  for (const object of sortObjectsForApply(objects)) {
    const rank = applyRankOf(object);
    const current = chunks[chunks.length - 1];
    if (!current) {
      chunks.push([object]);
      continue;
    }

    const currentRank = applyRankOf(current[0]);
    if (currentRank === rank) {
      current.push(object);
    } else {
      chunks.push([object]);
    }
  }

  return chunks;
};

/**
 * Build the REST path for an object given its (statically-known or
 * discovered) kind spec.
 */
export const buildKubernetesObjectPathWithSpec = (
  input: Pick<
    KubernetesObjectRef,
    "apiVersion" | "kind" | "name" | "namespace"
  >,
  spec: KubernetesObjectKindSpec,
) => {
  const [group, version] = input.apiVersion.includes("/")
    ? input.apiVersion.split("/", 2)
    : [undefined, input.apiVersion];

  const base = group ? `/apis/${group}/${version}` : `/api/${version}`;

  if (spec.scope === "Namespaced") {
    if (!input.namespace) {
      throw new Error(
        `Kubernetes object ${input.apiVersion}/${input.kind}/${input.name} requires a namespace`,
      );
    }

    return `${base}/namespaces/${input.namespace}/${spec.plural}/${input.name}`;
  }

  return `${base}/${spec.plural}/${input.name}`;
};

export const buildKubernetesObjectPath = (
  input: Pick<
    KubernetesObjectRef,
    "apiVersion" | "kind" | "name" | "namespace"
  >,
) => buildKubernetesObjectPathWithSpec(input, getKubernetesKindSpec(input));
