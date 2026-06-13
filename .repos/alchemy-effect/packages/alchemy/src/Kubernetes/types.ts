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

type KubernetesObjectScope = "Cluster" | "Namespaced";

interface KubernetesObjectKindSpec {
  plural: string;
  scope: KubernetesObjectScope;
  applyRank: number;
}

const supportedKinds: Record<string, KubernetesObjectKindSpec> = {
  "v1/Namespace": {
    plural: "namespaces",
    scope: "Cluster",
    applyRank: 10,
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
  "batch/v1/Job": {
    plural: "jobs",
    scope: "Namespaced",
    applyRank: 60,
  },
};

const objectTypeKey = (
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">,
) => `${input.apiVersion}/${input.kind}`;

export const getKubernetesKindSpec = (
  input: Pick<KubernetesObjectRef, "apiVersion" | "kind">,
) => {
  const spec = supportedKinds[objectTypeKey(input)];
  if (!spec) {
    throw new Error(
      `Unsupported Kubernetes object ${input.apiVersion}/${input.kind}`,
    );
  }
  return spec;
};

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

export const kubernetesBindingSid = (object: KubernetesObjectDefinition) =>
  `Kubernetes.Object(${kubernetesObjectKey(toKubernetesObjectRef(object))})`;

const compareRefs = (a: KubernetesObjectRef, b: KubernetesObjectRef) =>
  kubernetesObjectKey(a).localeCompare(kubernetesObjectKey(b));

export const sortObjectsForApply = (
  objects: ReadonlyArray<KubernetesObjectDefinition>,
) =>
  [...objects].sort(
    (a, b) =>
      getKubernetesKindSpec(a).applyRank - getKubernetesKindSpec(b).applyRank ||
      compareRefs(toKubernetesObjectRef(a), toKubernetesObjectRef(b)),
  );

export const sortRefsForDelete = (
  objects: ReadonlyArray<KubernetesObjectRef>,
) =>
  [...objects].sort(
    (a, b) =>
      getKubernetesKindSpec(b).applyRank - getKubernetesKindSpec(a).applyRank ||
      compareRefs(a, b),
  );

export const chunkByApplyRank = (
  objects: ReadonlyArray<KubernetesObjectDefinition>,
) => {
  const chunks: KubernetesObjectDefinition[][] = [];

  for (const object of sortObjectsForApply(objects)) {
    const rank = getKubernetesKindSpec(object).applyRank;
    const current = chunks[chunks.length - 1];
    if (!current) {
      chunks.push([object]);
      continue;
    }

    const currentRank = getKubernetesKindSpec(current[0]).applyRank;
    if (currentRank === rank) {
      current.push(object);
    } else {
      chunks.push([object]);
    }
  }

  return chunks;
};

export const buildKubernetesObjectPath = (
  input: Pick<
    KubernetesObjectRef,
    "apiVersion" | "kind" | "name" | "namespace"
  >,
) => {
  const spec = getKubernetesKindSpec(input);
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
