import * as Kubernetes from "@alchemy.run/kubernetes";
import {
  appliedObjectsMatch,
  driftMask,
  hashDriftSelection,
} from "@alchemy.run/kubernetes/internal/declared";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { toYamlDisplayValue } from "alchemy/Cli/PropertyDiff";
import { encodeState, reviveStateRecursive } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({
  providers: Layer.mergeAll(Kubernetes.providers(), NodeServices.layer),
});

test(
  "declared lists with a merge key compare by that key",
  Effect.sync(() => {
    const desired = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: {
          spec: {
            containers: [
              { name: "a", image: "a:1" },
              { name: "b", image: "b:1" },
            ],
          },
        },
      },
    };
    const preview = {
      ...desired,
      metadata: { name: "app", uid: "u", resourceVersion: "9" },
    };
    const reordered = {
      ...preview,
      spec: {
        template: {
          spec: {
            containers: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
          },
        },
      },
    };
    expect(appliedObjectsMatch(reordered, preview, desired)).toBe(true);
    const edited = {
      ...reordered,
      spec: {
        template: {
          spec: {
            containers: [
              { name: "b", image: "b:2" },
              { name: "a", image: "a:1" },
            ],
          },
        },
      },
    };
    expect(appliedObjectsMatch(edited, preview, desired)).toBe(false);
    const tolerations = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "app" },
      spec: {
        tolerations: [
          {
            key: "disk",
            operator: "Equal",
            value: "ssd",
            effect: "NoSchedule",
          },
          { key: "disk", operator: "Exists", effect: "NoExecute" },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...tolerations,
          spec: {
            tolerations: [
              { key: "disk", operator: "Exists", effect: "NoExecute" },
              {
                key: "disk",
                operator: "Equal",
                value: "ssd",
                effect: "NoSchedule",
              },
            ],
          },
        },
        tolerations,
        tolerations,
      ),
    ).toBe(false);
    expect(
      appliedObjectsMatch(
        {
          ...tolerations,
          spec: {
            tolerations: [
              {
                key: "disk",
                operator: "Equal",
                value: "ssd",
                effect: "NoExecute",
              },
              { key: "disk", operator: "Exists", effect: "NoExecute" },
            ],
          },
        },
        tolerations,
        tolerations,
      ),
    ).toBe(false);
    expect(
      appliedObjectsMatch(
        {
          ...tolerations,
          spec: {
            tolerations: [
              ...tolerations.spec.tolerations,
              { key: "gpu", operator: "Exists", effect: "NoSchedule" },
            ],
          },
        },
        tolerations,
        tolerations,
      ),
    ).toBe(false);
    const bare = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "app" },
      spec: { tolerations: [{ key: "gpu" }] },
    };
    const defaulted = {
      ...bare,
      spec: { tolerations: [{ key: "gpu", operator: "Equal" }] },
    };
    expect(appliedObjectsMatch(defaulted, bare, bare)).toBe(true);
    expect(
      appliedObjectsMatch(
        {
          ...bare,
          spec: { tolerations: [{ key: "tpu", operator: "Equal" }] },
        },
        defaulted,
        bare,
      ),
    ).toBe(false);
    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "app" },
      spec: {
        ports: [
          { name: "http", port: 80 },
          { name: "https", port: 443 },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...service,
          spec: {
            ports: [
              { name: "https", port: 443 },
              { name: "http", port: 80 },
            ],
          },
        },
        service,
        service,
      ),
    ).toBe(true);
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "token" },
      stringData: Redacted.make({ token: "s3cr3t" }),
    };
    const encode = (value: string) => Buffer.from(value).toString("base64");
    expect(JSON.stringify(driftMask(secret))).not.toContain("s3cr3t");
    expect(
      appliedObjectsMatch(
        {
          ...secret,
          stringData: undefined,
          data: { token: encode("s3cr3t"), extra: encode("other-value") },
        },
        {
          ...secret,
          stringData: undefined,
          data: { token: encode("s3cr3t") },
        },
        secret,
      ),
    ).toBe(true);
    const indexed = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "c" },
      data: { items: ["a", "b"] },
    };
    expect(appliedObjectsMatch({ ...indexed, data: { items: ["b", "a"] } }, indexed, indexed)).toBe(
      false,
    );
    expect(
      appliedObjectsMatch({ ...indexed, data: { items: ["a", "b", "c"] } }, indexed, indexed),
    ).toBe(false);
    const named = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: {
        items: [
          { name: "a", image: "a:1" },
          { name: "b", image: "b:1" },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...named,
          spec: {
            items: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
          },
        },
        named,
        named,
      ),
    ).toBe(false);
    const crdContainers = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: {
        containers: [
          { name: "a", image: "a:1" },
          { name: "b", image: "b:1" },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...crdContainers,
          spec: {
            containers: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
          },
        },
        crdContainers,
        crdContainers,
      ),
    ).toBe(false);
    expect(
      appliedObjectsMatch(
        {
          ...crdContainers,
          spec: {
            containers: [
              { name: "a", image: "a:1" },
              { name: "b", image: "b:1" },
              { name: "c", image: "c:1" },
            ],
          },
        },
        crdContainers,
        crdContainers,
      ),
    ).toBe(false);
    const mapItems = {
      ...named,
      metadata: {
        name: "w",
        managedFields: [
          {
            manager: "alchemy",
            fieldsV1: {
              "f:spec": {
                "f:items": {
                  'k:{"name":"a"}': { ".": {} },
                },
              },
            },
          },
        ],
      },
    };
    const mapReordered = {
      ...mapItems,
      spec: {
        items: [
          { name: "b", image: "b:1" },
          { name: "a", image: "a:1" },
        ],
      },
    };
    expect(appliedObjectsMatch(mapReordered, mapItems, mapItems)).toBe(true);
    expect(JSON.stringify(driftMask(mapItems))).toContain('"spec.items"');
    const k8sIoCrd = {
      apiVersion: "widgets.acme.k8s.io/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: {
        containers: [
          { name: "a", image: "a:1" },
          { name: "b", image: "b:1" },
        ],
      },
    };
    expect(
      appliedObjectsMatch(
        {
          ...k8sIoCrd,
          spec: {
            containers: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
          },
        },
        k8sIoCrd,
        k8sIoCrd,
      ),
    ).toBe(false);
    const codes = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: {
        name: "w",
        managedFields: [
          {
            manager: "alchemy",
            fieldsV1: { "f:spec": { "f:codes": { "v:1": {} } } },
          },
        ],
      },
      spec: { codes: [1, true] },
    };
    expect(
      appliedObjectsMatch(
        { ...codes, spec: { codes: [true, 1, 2] } },
        { ...codes, spec: { codes: [1, true] } },
        codes,
      ),
    ).toBe(true);
    expect(appliedObjectsMatch({ ...codes, spec: { codes: [true] } }, codes, codes)).toBe(false);
    const settings = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: { settings: { a: 1 } },
    };
    // Undeclared map keys are not part of the selection.
    expect(
      appliedObjectsMatch({ ...settings, spec: { settings: { a: 1, b: 2 } } }, settings, settings),
    ).toBe(true);
    expect(
      appliedObjectsMatch({ ...settings, spec: { settings: { a: 2 } } }, settings, settings),
    ).toBe(false);
  }),
  { tags: ["provider:kubernetes", "local"] },
);

type DriftMeta = {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  uid?: string;
  resourceVersion?: string;
};

type DriftDeployment = {
  apiVersion: string;
  kind: string;
  metadata: DriftMeta;
  spec: {
    replicas?: number;
    revisionHistoryLimit?: number;
    selector?: { matchLabels: Record<string, string> };
    template: { metadata: DriftMeta; spec: Record<string, unknown> };
  };
};

const deployment = (name: string, spec: DriftDeployment["spec"]): DriftDeployment => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name, namespace: "default" },
  spec,
});

const podSpec = (spec: Record<string, unknown>): DriftDeployment["spec"] => ({
  selector: { matchLabels: { app: "web" } },
  template: { metadata: { labels: { app: "web" } }, spec },
});

test(
  "drift selection keeps declared fields and ignores server-owned ones",
  Effect.gen(function* () {
    const declared = deployment("app", {
      ...podSpec({ containers: [{ name: "app", image: "app:1" }] }),
    });
    const canonical = {
      ...declared,
      metadata: { ...declared.metadata, uid: "u", resourceVersion: "1" },
      spec: {
        replicas: 1,
        revisionHistoryLimit: 10,
        ...declared.spec,
        template: {
          ...declared.spec.template,
          spec: {
            containers: [{ name: "app", image: "app:1", imagePullPolicy: "IfNotPresent" }],
          },
        },
      },
    };
    const mask = driftMask(declared);
    const baseline = yield* hashDriftSelection(declared, canonical);
    expect(yield* hashDriftSelection(mask, canonical)).toBe(baseline);
    // Older state has no canonical hash. The same selection against the
    // declaration ignores apiserver defaults.
    expect(yield* hashDriftSelection(mask, declared)).toBe(
      yield* hashDriftSelection(mask, canonical),
    );
    const resized = { ...canonical, spec: { ...canonical.spec, replicas: 5 } };
    expect(yield* hashDriftSelection(mask, resized)).toBe(baseline);

    const pinned = deployment("pinned", {
      replicas: 2,
      ...podSpec({ containers: [{ name: "app", image: "app:1" }] }),
    });
    const pinnedMask = driftMask(pinned);
    const pinnedBaseline = yield* hashDriftSelection(pinned, pinned);
    expect(
      yield* hashDriftSelection(pinnedMask, { ...pinned, spec: { ...pinned.spec, replicas: 3 } }),
    ).not.toBe(pinnedBaseline);

    const noted = deployment("noted", {
      ...podSpec({ containers: [{ name: "app", image: "app:1" }] }),
    });
    noted.metadata = {
      ...noted.metadata,
      annotations: { app: "web" },
    };
    (
      noted.spec.template as {
        metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
      }
    ).metadata = {
      labels: { app: "web" },
      annotations: { "prometheus.io/scrape": "true" },
    };
    const notedMask = driftMask(noted);
    const notedBaseline = yield* hashDriftSelection(noted, noted);
    const controller = {
      ...noted,
      metadata: {
        ...noted.metadata,
        annotations: { app: "web", "deployment.kubernetes.io/revision": "4" },
      },
    };
    expect(yield* hashDriftSelection(notedMask, controller)).toBe(notedBaseline);
    const edited = {
      ...noted,
      metadata: { ...noted.metadata, annotations: { app: "api" } },
    };
    expect(yield* hashDriftSelection(notedMask, edited)).not.toBe(notedBaseline);
    const dropped = {
      ...noted,
      metadata: { ...noted.metadata, annotations: {} },
    };
    expect(yield* hashDriftSelection(notedMask, dropped)).not.toBe(notedBaseline);
    const template = noted.spec.template as {
      metadata: { labels: Record<string, string>; annotations: Record<string, string> };
      spec: unknown;
    };
    const templateEdited = {
      ...noted,
      spec: {
        ...noted.spec,
        template: {
          ...template,
          metadata: { ...template.metadata, annotations: { "prometheus.io/scrape": "false" } },
        },
      },
    };
    expect(yield* hashDriftSelection(notedMask, templateEdited)).not.toBe(notedBaseline);
    const templateDropped = {
      ...noted,
      spec: {
        ...noted.spec,
        template: { ...template, metadata: { labels: { app: "web" } } },
      },
    };
    expect(yield* hashDriftSelection(notedMask, templateDropped)).not.toBe(notedBaseline);

    const ordered = deployment("ordered", {
      ...podSpec({
        initContainers: [
          { name: "a", image: "a:1" },
          { name: "b", image: "b:1" },
        ],
        containers: [
          { name: "app", image: "app:1" },
          { name: "sidecar", image: "sidecar:1" },
        ],
      }),
    });
    const orderedMask = driftMask(ordered);
    const orderedBaseline = yield* hashDriftSelection(ordered, ordered);
    const reversedInit = {
      ...ordered,
      spec: {
        ...ordered.spec,
        template: {
          ...ordered.spec.template,
          spec: {
            initContainers: [
              { name: "b", image: "b:1" },
              { name: "a", image: "a:1" },
            ],
            containers: [
              { name: "sidecar", image: "sidecar:1" },
              { name: "app", image: "app:1" },
            ],
          },
        },
      },
    };
    // initContainers is a map list: order is not part of the merge key.
    expect(yield* hashDriftSelection(orderedMask, reversedInit)).toBe(orderedBaseline);
    const reversedContainers = {
      ...ordered,
      spec: {
        ...ordered.spec,
        template: {
          ...ordered.spec.template,
          spec: {
            initContainers: [
              { name: "a", image: "a:1" },
              { name: "b", image: "b:1" },
            ],
            containers: [
              { name: "sidecar", image: "sidecar:1" },
              { name: "app", image: "app:1" },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(orderedMask, reversedContainers)).toBe(orderedBaseline);

    const dns = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "dns" },
      spec: {
        ports: [
          { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 },
          { name: "dns-udp", port: 53, protocol: "UDP", targetPort: 53 },
        ],
      },
    };
    const dnsMask = driftMask(dns);
    const dnsBaseline = yield* hashDriftSelection(dns, dns);
    expect(yield* hashDriftSelection(dnsMask, dns)).toBe(dnsBaseline);
    const udpEdited = {
      ...dns,
      spec: {
        ports: [dns.spec.ports[0], { ...dns.spec.ports[1], targetPort: 5353 }],
      },
    };
    expect(yield* hashDriftSelection(dnsMask, udpEdited)).not.toBe(dnsBaseline);
    const http = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "http" },
      spec: { ports: [{ port: 80, targetPort: 80 }] },
    };
    expect(
      yield* hashDriftSelection(driftMask(http), {
        ...http,
        spec: { ports: [{ port: 80, protocol: "TCP", targetPort: 80 }] },
      }),
    ).toBe(yield* hashDriftSelection(http, http));
    const probed = deployment("probed", {
      ...podSpec({
        containers: [
          {
            name: "app",
            image: "app:1",
            ports: [
              { name: "dns-tcp", containerPort: 53, protocol: "TCP", hostPort: 53 },
              { name: "dns-udp", containerPort: 53, protocol: "UDP", hostPort: 53 },
            ],
          },
        ],
      }),
    });
    const probedMask = driftMask(probed);
    const probedBaseline = yield* hashDriftSelection(probed, probed);
    const probedSpec = probed.spec.template as unknown as {
      spec: { containers: Array<{ ports: Array<Record<string, unknown>> }> };
    };
    const probedEdited = {
      ...probed,
      spec: {
        ...probed.spec,
        template: {
          ...probed.spec.template,
          spec: {
            containers: [
              {
                ...probedSpec.spec.containers[0],
                ports: [
                  probedSpec.spec.containers[0]!.ports[0],
                  { ...probedSpec.spec.containers[0]!.ports[1], hostPort: 5353 },
                ],
              },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(probedMask, probedEdited)).not.toBe(probedBaseline);

    const namespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "team",
        finalizers: ["example.com/keep", "example.com/other"],
      },
    };
    const namespaceMask = driftMask(namespace);
    const namespaceBaseline = yield* hashDriftSelection(namespace, namespace);
    expect(yield* hashDriftSelection(namespaceMask, namespace)).toBe(namespaceBaseline);
    expect(
      yield* hashDriftSelection(namespaceMask, {
        ...namespace,
        metadata: {
          ...namespace.metadata,
          finalizers: ["kubernetes", "example.com/other", "example.com/keep"],
        },
      }),
    ).toBe(namespaceBaseline);
    expect(
      yield* hashDriftSelection(namespaceMask, {
        ...namespace,
        metadata: {
          ...namespace.metadata,
          finalizers: ["kubernetes", "example.com/other"],
        },
      }),
    ).not.toBe(namespaceBaseline);

    const sized = deployment("sized", {
      ...podSpec({
        containers: [
          {
            name: "app",
            image: "app:1",
            resources: { requests: { cpu: "0.1", memory: "1.5Gi" } },
            ports: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      }),
    });
    const sizedMask = driftMask(sized);
    const sizedLive = {
      ...sized,
      spec: {
        ...sized.spec,
        template: {
          ...sized.spec.template,
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1",
                resources: { requests: { cpu: "100m", memory: "1536Mi" } },
                ports: [{ containerPort: 80, protocol: "TCP" }],
              },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(sizedMask, sizedLive)).toBe(
      yield* hashDriftSelection(sizedMask, sized),
    );
    const resizedCpu = {
      ...sizedLive,
      spec: {
        ...sizedLive.spec,
        template: {
          ...sizedLive.spec.template,
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1",
                resources: { requests: { cpu: "200m", memory: "1536Mi" } },
                ports: [{ containerPort: 80, protocol: "TCP" }],
              },
            ],
          },
        },
      },
    };
    expect(yield* hashDriftSelection(sizedMask, resizedCpu)).not.toBe(
      yield* hashDriftSelection(sizedMask, sized),
    );

    const claim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "data" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1.5Gi" } },
      },
    };
    const claimLive = {
      ...claim,
      spec: {
        ...claim.spec,
        resources: { requests: { storage: "1536Mi" } },
      },
    };
    expect(yield* hashDriftSelection(driftMask(claim), claimLive)).toBe(
      yield* hashDriftSelection(driftMask(claim), claim),
    );

    const quota = {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "team" },
      spec: {
        hard: {
          "requests.cpu": "0.1",
          "limits.memory": "1.5Gi",
          "requests.storage": "1.5Gi",
        },
      },
    };
    expect(
      yield* hashDriftSelection(driftMask(quota), {
        ...quota,
        spec: {
          hard: {
            "requests.cpu": "100m",
            "limits.memory": "1536Mi",
            "requests.storage": "1536Mi",
          },
        },
      }),
    ).toBe(yield* hashDriftSelection(driftMask(quota), quota));

    const config = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "cfg" },
      data: { memory: "1Gi", cpu: "1", protocol: "tcp" },
    };
    expect(
      yield* hashDriftSelection(driftMask(config), {
        ...config,
        data: { memory: "1024Mi", cpu: "1000m", protocol: "TCP" },
      }),
    ).not.toBe(yield* hashDriftSelection(driftMask(config), config));
  }),
  { tags: ["provider:kubernetes", "local"] },
);

const containers = [
  { name: "a", image: "a:1" },
  { name: "b", image: "b:1" },
];

const reorderedContainers = [
  { name: "b", image: "b:1" },
  { name: "a", image: "a:1" },
];

const deploymentList = (fieldsV1?: unknown) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata:
    fieldsV1 === undefined
      ? { name: "app" }
      : {
          name: "app",
          managedFields: [{ manager: "alchemy", fieldsV1 }],
        },
  spec: { template: { spec: { containers } } },
});

const containerFields = (node: Record<string, unknown>) => ({
  "f:spec": { "f:template": { "f:spec": { "f:containers": node } } },
});

test(
  "fieldsV1 topology is reused on a later read",
  Effect.gen(function* () {
    const widget = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: { containers },
    };
    const widgetWitness = {
      ...widget,
      metadata: {
        name: "w",
        managedFields: [
          {
            manager: "alchemy",
            fieldsV1: {
              "f:spec": {
                "f:containers": {
                  ".": {},
                  'k:{"name":"a"}': { ".": {} },
                  'k:{"name":"b"}': { ".": {} },
                },
              },
            },
          },
        ],
      },
    };
    const widgetMask = driftMask(widget, widgetWitness);
    const widgetReordered = { ...widget, spec: { containers: reorderedContainers } };
    const widgetMissing = { ...widget, spec: { containers: [containers[0]] } };
    const widgetExtra = {
      ...widget,
      spec: { containers: [...containers, { name: "c", image: "c:1" }] },
    };
    const widgetBaseline = yield* hashDriftSelection(widgetMask, widget);
    // The raw CRD list is atomic. The stored apply topology is what ignores order.
    expect(yield* hashDriftSelection(widget, widgetReordered)).not.toBe(
      yield* hashDriftSelection(widget, widget),
    );
    expect(yield* hashDriftSelection(widgetMask, widgetReordered)).toBe(widgetBaseline);
    expect(yield* hashDriftSelection(widgetMask, widgetExtra)).toBe(widgetBaseline);
    expect(yield* hashDriftSelection(widgetMask, widgetMissing)).not.toBe(widgetBaseline);

    const blank = deploymentList();
    const blankMask = driftMask(blank);
    const blankReordered = {
      ...blank,
      spec: { template: { spec: { containers: reorderedContainers } } },
    };
    const blankMissing = {
      ...blank,
      spec: { template: { spec: { containers: [containers[0]] } } },
    };
    const blankBaseline = yield* hashDriftSelection(blankMask, blank);
    expect(yield* hashDriftSelection(blankMask, blankReordered)).toBe(blankBaseline);
    expect(yield* hashDriftSelection(blankMask, blankMissing)).not.toBe(blankBaseline);

    const keyed = deploymentList(
      containerFields({
        ".": {},
        'k:{"name":"a"}': { ".": {} },
        'k:{"name":"b"}': { ".": {} },
      }),
    );
    const keyedMask = driftMask(deploymentList(), keyed);
    const keyedBaseline = yield* hashDriftSelection(keyedMask, deploymentList());
    expect(
      yield* hashDriftSelection(keyedMask, {
        ...deploymentList(),
        spec: { template: { spec: { containers: reorderedContainers } } },
      }),
    ).toBe(keyedBaseline);

    // An owned list with no k: entry is atomic until a later apply stores one.
    const emptyOwned = deploymentList(containerFields({ ".": {} }));
    const emptyMask = driftMask(deploymentList(), emptyOwned);
    expect(JSON.stringify(emptyMask)).toContain('"spec.template.spec.containers":"atomic"');
    const emptyBaseline = yield* hashDriftSelection(emptyMask, deploymentList());
    expect(
      yield* hashDriftSelection(emptyMask, {
        ...deploymentList(),
        spec: { template: { spec: { containers: reorderedContainers } } },
      }),
    ).not.toBe(emptyBaseline);
  }),
  { tags: ["provider:kubernetes", "local"] },
);

test(
  "empty owned finalizers are a set and an appended toleration drifts",
  Effect.gen(function* () {
    const finalizers: string[] = [];
    const namespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "team", finalizers },
    };
    const finalizerWitness = (fields: ReadonlyArray<Record<string, unknown>>) => ({
      ...namespace,
      metadata: {
        ...namespace.metadata,
        managedFields: fields.map((fieldsV1) => ({ manager: "alchemy", fieldsV1 })),
      },
    });
    const dotOnly = { "f:metadata": { "f:finalizers": { ".": {} } } };
    const withMember = {
      "f:metadata": { "f:finalizers": { ".": {}, 'v:"kubernetes"': {} } },
    };
    const emptySet = driftMask(namespace, finalizerWitness([dotOnly]));
    const dotThenMember = driftMask(namespace, finalizerWitness([dotOnly, withMember]));
    const memberThenDot = driftMask(namespace, finalizerWitness([withMember, dotOnly]));
    expect(JSON.stringify(emptySet)).toContain('"metadata.finalizers":"set"');
    expect(JSON.stringify(dotThenMember)).toContain('"metadata.finalizers":"set"');
    expect(JSON.stringify(memberThenDot)).toContain('"metadata.finalizers":"set"');
    const addedFinalizer = {
      ...namespace,
      metadata: { name: "team", finalizers: ["kubernetes"] },
    };
    for (const mask of [emptySet, dotThenMember, memberThenDot]) {
      const baseline = yield* hashDriftSelection(mask, namespace);
      expect(yield* hashDriftSelection(mask, addedFinalizer)).toBe(baseline);
    }
    const kept = {
      ...namespace,
      metadata: { name: "team", finalizers: ["example.com/keep"] },
    };
    const keptMask = driftMask(kept, finalizerWitness([dotOnly]));
    expect(
      yield* hashDriftSelection(keptMask, {
        ...kept,
        metadata: { name: "team", finalizers: ["kubernetes"] },
      }),
    ).not.toBe(yield* hashDriftSelection(keptMask, kept));

    const codes = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: { codes: ["a"] },
    };
    const codeFields = (node: Record<string, unknown>) => ({
      "f:spec": { "f:codes": node },
    });
    const dotThenValue = driftMask(codes, {
      ...codes,
      metadata: {
        name: "w",
        managedFields: [
          { manager: "empty", fieldsV1: codeFields({ ".": {} }) },
          { manager: "member", fieldsV1: codeFields({ ".": {}, 'v:"a"': {} }) },
        ],
      },
    });
    const valueThenDot = driftMask(codes, {
      ...codes,
      metadata: {
        name: "w",
        managedFields: [
          { manager: "member", fieldsV1: codeFields({ ".": {}, 'v:"a"': {} }) },
          { manager: "empty", fieldsV1: codeFields({ ".": {} }) },
        ],
      },
    });
    expect(JSON.stringify(dotThenValue)).toContain('"spec.codes":"set"');
    expect(JSON.stringify(valueThenDot)).toContain('"spec.codes":"set"');
    const codesBaseline = yield* hashDriftSelection(dotThenValue, codes);
    expect(yield* hashDriftSelection(dotThenValue, { ...codes, spec: { codes: ["b", "a"] } })).toBe(
      codesBaseline,
    );
    expect(yield* hashDriftSelection(valueThenDot, { ...codes, spec: { codes: ["b"] } })).not.toBe(
      yield* hashDriftSelection(valueThenDot, codes),
    );

    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "app" },
      spec: {
        tolerations: [{ key: "disk", operator: "Equal", value: "ssd", effect: "NoSchedule" }],
      },
    };
    const podMask = driftMask(pod, {
      ...pod,
      metadata: {
        name: "app",
        managedFields: [{ manager: "alchemy", fieldsV1: { "f:spec": { "f:tolerations": {} } } }],
      },
    });
    expect(JSON.stringify(podMask)).not.toContain('"spec.tolerations"');
    const podBaseline = yield* hashDriftSelection(podMask, pod);
    expect(
      yield* hashDriftSelection(podMask, {
        ...pod,
        spec: {
          tolerations: [
            ...pod.spec.tolerations,
            { key: "gpu", operator: "Exists", effect: "NoSchedule" },
          ],
        },
      }),
    ).not.toBe(podBaseline);
  }),
  { tags: ["provider:kubernetes", "local"] },
);

test(
  "a redacted set identity stays wrapped in the drift mask",
  Effect.gen(function* () {
    const token = "private-token";
    const declared = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: { tokens: Redacted.make([token]) },
    };
    const witness = {
      ...declared,
      metadata: {
        name: "w",
        managedFields: [
          {
            manager: "alchemy",
            fieldsV1: { "f:spec": { "f:tokens": { ".": {}, 'v:"private-token"': {} } } },
          },
        ],
      },
      spec: { tokens: [token] },
    };
    const mask = driftMask(declared, witness);
    const revived = reviveStateRecursive(JSON.parse(JSON.stringify(encodeState(mask))));
    const shown = JSON.stringify(toYamlDisplayValue(revived));
    expect(shown).not.toContain(token);
    expect(shown).toContain("(redacted)");
    expect(JSON.stringify(toYamlDisplayValue(declared))).not.toContain(token);

    const present = {
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "w" },
      spec: { tokens: [token, "other"] },
    };
    const baseline = yield* hashDriftSelection(revived, present);
    expect(yield* hashDriftSelection(mask, present)).toBe(baseline);
    expect(
      yield* hashDriftSelection(revived, { ...present, spec: { tokens: ["other"] } }),
    ).not.toBe(baseline);

    const named = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app" },
      spec: {
        template: { spec: { containers: [{ name: Redacted.make(token), image: "app:1" }] } },
      },
    };
    const namedMask = driftMask(named);
    expect(JSON.stringify(toYamlDisplayValue(namedMask))).not.toContain(token);
    const live = {
      ...named,
      spec: { template: { spec: { containers: [{ name: token, image: "app:2" }] } } },
    };
    expect(yield* hashDriftSelection(namedMask, live)).toBe(
      yield* hashDriftSelection(
        driftMask({
          ...named,
          spec: { template: { spec: { containers: [{ name: token, image: "app:1" }] } } },
        }),
        live,
      ),
    );
  }),
  { tags: ["provider:kubernetes", "local"] },
);
