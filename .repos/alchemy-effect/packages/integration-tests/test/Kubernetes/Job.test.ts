import * as AWS from "@alchemy.run/aws";
import * as Kubernetes from "@alchemy.run/kubernetes";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Provider from "alchemy/Provider";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  destroyKindStack,
  KindTestCluster,
  kubectlGet,
  removeRbac,
  restrictedConnection,
  updateRole,
  type KindCluster,
} from "./fixtures/kind.ts";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// Ungated probe: `Job` is a composite host (in-cluster batch/v1 Job or
// CronJob plus adapter-owned cloud resources on managed clusters) with no
// faithful single-API enumeration, so `list()` is intentionally empty. The
// probe proves the provider is registered and its record type-checks.
test.provider(
  "list returns an empty array (composite host, not enumerable)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.Job);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
  { tags: ["provider:aws", "provider:kubernetes", "provider:kubernetes:job", "live"] },
);

const kindStack = Core.scratchStack(testOptions, "KubernetesJobKind");

// Creates a real kind cluster (~30s); needs Docker, kind, and kubectl. The
// Job runs a pre-built image; these cases assert on the applied objects.
describe(
  "Kubernetes Job on kind",
  {
    tags: [
      "provider:kubernetes",
      "provider:kubernetes:job",
      "provider:kubernetes:localcluster",
      "live",
    ],
  },
  () => {
    let cluster: KindCluster;
    const image = "registry.k8s.io/pause:3.10";
    const ns = ["--namespace", "default"];
    const readJob = (name: string) => kubectlGet(cluster, ["job", name, ...ns]);
    // Background propagation removes the Job object shortly after DELETE.
    const waitGone = (name: string) =>
      readJob(name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (job) => job === undefined,
          times: 20,
        }),
      );
    const envOf = (job: any): Record<string, string> =>
      Object.fromEntries(
        (job.spec.template.spec.containers[0].env as { name: string; value: string }[]).map(
          (entry) => [entry.name, entry.value],
        ),
      );

    beforeAll(
      Effect.gen(function* () {
        yield* kindStack.destroy();
        cluster = yield* kindStack.deploy(KindTestCluster("job", 5065));
      }),
      { timeout: 300_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.suspend(() => destroyKindStack(kindStack, cluster)),
      { timeout: 180_000 },
    );

    test.provider(
      "one-shot job names follow unwrapped Redacted env values",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const job = (token: string) =>
            Kubernetes.Job("Rotate", {
              cluster: cluster.connection,
              name: "rotate",
              image,
              backoffLimit: 0,
              env: { TOKEN: Redacted.make(token) },
            });

          const first = yield* stack.deploy(job("job-token-sentinel-a"));
          expect(envOf(yield* readJob(first.jobName)).TOKEN).toBe("job-token-sentinel-a");
          expect(JSON.stringify(first.kubernetesObjects)).not.toContain("sentinel");

          // Same secret value, fresh Redacted wrapper: same content address.
          const again = yield* stack.deploy(job("job-token-sentinel-a"));
          expect(again.jobName).toBe(first.jobName);

          // A rotated secret is a new spec: a new Job replaces the old one.
          const rotated = yield* stack.deploy(job("job-token-sentinel-b"));
          expect(rotated.jobName).not.toBe(first.jobName);
          expect(envOf(yield* readJob(rotated.jobName)).TOKEN).toBe("job-token-sentinel-b");
          expect(yield* waitGone(first.jobName)).toBe(undefined);

          yield* stack.destroy();
          expect(yield* waitGone(rotated.jobName)).toBe(undefined);
          expect(yield* kubectlGet(cluster, ["serviceaccount", "rotate", ...ns])).toBe(undefined);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "destroy surfaces a 403 and leaves the objects in place",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const account = "job-no-delete";
          const rules = (verbs: string[]) => [
            { apiGroups: [""], resources: ["serviceaccounts"], verbs },
            { apiGroups: ["batch"], resources: ["jobs"], verbs },
          ];
          const restricted = yield* restrictedConnection(
            cluster,
            account,
            rules(["get", "list", "create", "patch", "update"]),
          );
          const deployed = yield* stack.deploy(
            Kubernetes.Job("Kept", {
              cluster: restricted,
              name: "kept",
              image,
              backoffLimit: 0,
            }),
          );

          const exit = yield* Effect.exit(stack.destroy());
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("403");
          }
          expect(yield* readJob(deployed.jobName)).toBeDefined();
          expect(yield* kubectlGet(cluster, ["serviceaccount", "kept", ...ns])).toBeDefined();

          // Granting delete lets the same destroy converge.
          yield* updateRole(
            cluster,
            account,
            rules(["get", "list", "create", "patch", "update", "delete"]),
          );
          yield* stack
            .destroy()
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 5 }));
          expect(yield* waitGone(deployed.jobName)).toBe(undefined);
          expect(yield* kubectlGet(cluster, ["serviceaccount", "kept", ...ns])).toBe(undefined);
          yield* removeRbac(cluster, account);
        }),
      { timeout: 120_000 },
    );
  },
);
