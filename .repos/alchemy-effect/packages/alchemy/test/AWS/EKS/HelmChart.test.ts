import * as AWS from "@/AWS";
import { HelmChart } from "@/AWS/EKS/HelmChart.ts";
import { renderHelmChart } from "@/AWS/EKS/internal/helm.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { spawnSync } from "node:child_process";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// Rendering shells out to the local helm CLI (like Docker for image
// builds); skip the render tests on machines without it.
const isHelmReady =
  spawnSync("helm", ["version"], { stdio: "ignore" }).status === 0;

const chartDir = `${import.meta.dirname}/fixtures/chart`;

const describe = layer(NodeServices.layer);

describe("renderHelmChart (local fixture)", (it) => {
  it.effect.skipIf(!isHelmReady)(
    "renders values, release name, and namespace",
    () =>
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

  it.effect.skipIf(!isHelmReady)(
    "values toggle conditional templates on and off",
    () =>
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
        expect(withSecond.map((object) => object.metadata.name).sort()).toEqual(
          ["probe-config", "probe-second"],
        );
      }),
  );

  it.effect.skipIf(!isHelmReady)(
    "a bad chart reference fails with a typed HelmError",
    () =>
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

// Ungated probe: chart objects live in-cluster with no AWS-side enumeration
// attributing them to alchemy, so `list()` is intentionally empty. Proves
// the provider is registered and its record type-checks; the live apply
// path rides the gated Deployment E2E cluster (Deployment.test.ts).
test.provider("list returns an empty array (in-cluster objects)", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(HelmChart);
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toEqual([]);
  }),
);
