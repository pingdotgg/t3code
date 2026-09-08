import * as AWS from "@/AWS";
import * as Kubernetes from "@/Kubernetes";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()),
};
const { test } = Test.make(testOptions);

// Ungated probe: `Manifest` applies in-cluster objects that have no
// cloud-side enumeration attributing them to alchemy, so `list()` is
// intentionally empty. The probe proves the provider is registered and its
// record type-checks. The full apply path shares the live-cluster budget
// problem of every Kubernetes workload test (an EKS control-plane create
// is ~15 min), so lifecycle coverage rides the gated Deployment E2E
// cluster rather than paying for its own; see Deployment.test.ts.
test.provider("list returns an empty array (in-cluster objects)", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Kubernetes.Manifest);
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toEqual([]);
  }),
);
