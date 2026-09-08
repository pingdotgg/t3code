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

// Ungated probe: `Job` is a composite host (in-cluster batch/v1 Job or
// CronJob plus adapter-owned cloud resources on managed clusters) with no
// faithful single-API enumeration, so `list()` is intentionally empty. The
// probe proves the provider is registered and its record type-checks
// without paying the ~15-minute EKS control-plane create. Full lifecycle
// coverage requires a live cluster and rides the gated Deployment E2E
// budget (AWS_TEST_SLOW) — see Deployment.test.ts.
test.provider(
  "list returns an empty array (composite host, not enumerable)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.Job);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
);
