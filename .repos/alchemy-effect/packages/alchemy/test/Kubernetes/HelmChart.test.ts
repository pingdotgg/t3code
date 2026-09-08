import * as AWS from "@/AWS";
import * as Kubernetes from "@/Kubernetes";
import {
  parseRenderedManifests,
  renderHelmChart,
} from "@/Kubernetes/internal/helm.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()),
};
const { test } = Test.make(testOptions);

// Rendering shells out to the local helm CLI (like Docker for image
// builds) — `helm` must be installed on the machine running this suite.
const chartDir = `${import.meta.dirname}/fixtures/chart`;

const describe = layer(NodeServices.layer);

describe("renderHelmChart (local fixture)", (it) => {
  it.effect("renders values, release name, and namespace", () =>
    Effect.gen(function* () {
      const objects = yield* renderHelmChart({
        chart: chartDir,
        releaseName: "probe",
        namespace: "demo",
        values: { message: "hello-from-values" },
      });
      expect(objects).toHaveLength(1);
      const configMap = objects[0]! as unknown as {
        kind: string;
        metadata: { name: string };
        data: Record<string, string>;
      };
      expect(configMap.kind).toBe("ConfigMap");
      expect(configMap.metadata.name).toBe("probe-config");
      expect(configMap.data.message).toBe("hello-from-values");
      expect(configMap.data.release).toBe("probe");
      expect(configMap.data.namespace).toBe("demo");
    }),
  );

  it.effect("values toggle conditional templates on and off", () =>
    Effect.gen(function* () {
      const withoutSecond = yield* renderHelmChart({
        chart: chartDir,
        releaseName: "probe",
        namespace: "demo",
      });
      expect(withoutSecond).toHaveLength(1);

      const withSecond = yield* renderHelmChart({
        chart: chartDir,
        releaseName: "probe",
        namespace: "demo",
        values: { secondConfigMap: { enabled: true } },
      });
      expect(withSecond).toHaveLength(2);
      expect(withSecond.map((object) => object.metadata.name).sort()).toEqual([
        "probe-config",
        "probe-second",
      ]);
    }),
  );

  // Regression for #1312: the fixture chart ships a `helm.sh/hook: pre-delete`
  // Job. HelmChart has no Helm release and no hook lifecycle, so the hook
  // must never enter the managed-object graph (where it would be created and
  // reconciled like an ordinary workload on every deploy).
  it.effect("excludes Helm lifecycle hooks from the render", () =>
    Effect.gen(function* () {
      const objects = yield* renderHelmChart({
        chart: chartDir,
        releaseName: "probe",
        namespace: "demo",
      });
      expect(objects.map((object) => object.kind)).not.toContain("Job");
      expect(objects.map((object) => object.metadata.name)).toEqual([
        "probe-config",
      ]);
    }),
  );

  it.effect("a bad chart reference fails with a typed HelmError", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        renderHelmChart({
          chart: `${chartDir}-does-not-exist`,
          releaseName: "probe",
          namespace: "demo",
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("HelmError");
      }
    }),
  );
});

describe("parseRenderedManifests", (it) => {
  it.effect("ignores Helm OCI pull metadata", () =>
    Effect.gen(function* () {
      const objects = yield* parseRenderedManifests(
        "oci://registry.example.test/charts/example",
        `Pulled: registry.example.test/charts/example:1.2.3
Digest: sha256:0123456789abcdef
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: example
`,
      );

      expect(objects).toHaveLength(1);
      expect(objects[0]?.kind).toBe("ConfigMap");
      expect(objects[0]?.metadata.name).toBe("example");
    }),
  );

  it.effect("excludes helm.sh/hook-annotated objects (#1312)", () =>
    Effect.gen(function* () {
      const objects = yield* parseRenderedManifests(
        "example",
        `apiVersion: v1
kind: ConfigMap
metadata:
  name: ordinary
---
apiVersion: batch/v1
kind: Job
metadata:
  name: uninstall-hook
  annotations:
    helm.sh/hook: pre-delete
---
apiVersion: v1
kind: Pod
metadata:
  name: smoke-test
  annotations:
    "helm.sh/hook": test
`,
      );

      expect(objects.map((object) => object.metadata.name)).toEqual([
        "ordinary",
      ]);
    }),
  );

  it.effect("rejects pull-shaped metadata for non-OCI charts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        parseRenderedManifests(
          "example",
          `Pulled: registry.example.test/charts/example:1.2.3
Digest: sha256:0123456789abcdef
`,
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("HelmError");
      }
    }),
  );

  it.effect("rejects pull metadata that is not the leading OCI preamble", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        parseRenderedManifests(
          "oci://registry.example.test/charts/example",
          `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
---
Pulled: registry.example.test/charts/example:1.2.3
Digest: sha256:0123456789abcdef
`,
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("HelmError");
      }
    }),
  );
});

// Ungated probe: chart objects live in-cluster with no cloud-side
// enumeration attributing them to alchemy, so `list()` is intentionally
// empty. Proves the provider is registered and its record type-checks; the
// live apply path rides the gated Deployment E2E cluster
// (Deployment.test.ts).
test.provider("list returns an empty array (in-cluster objects)", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Kubernetes.HelmChart);
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toEqual([]);
  }),
);
