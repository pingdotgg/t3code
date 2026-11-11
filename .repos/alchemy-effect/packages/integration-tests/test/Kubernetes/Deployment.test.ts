import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Cluster } from "@alchemy.run/aws/EKS/Cluster";
import { makeEksTransport } from "@alchemy.run/aws/EKS/KubernetesAdapter";
import * as Kubernetes from "@alchemy.run/kubernetes";
import { readObject } from "@alchemy.run/kubernetes/Client";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Provider from "alchemy/Provider";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import EksHostApi from "./fixtures/deployment.ts";
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

// Ungated probe: `Deployment` is a composite host (in-cluster
// Deployment/Service plus adapter-owned cloud resources — ECR repo,
// pod-identity role, PodIdentityAssociation on EKS). It has no faithful
// single-API enumeration, so `list()` is intentionally empty. This probe
// proves the provider is registered, its record type-checks (a missing /
// mistyped `list` collapses Provider.of inference), and it runs live —
// without paying the ~15-minute EKS control-plane create.
test.provider(
  "list returns an empty array (composite host, not enumerable)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.Deployment);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
  { tags: ["provider:aws", "provider:kubernetes", "provider:kubernetes:deployment", "live"] },
);

const kindStack = Core.scratchStack(testOptions, "KubernetesDeploymentKind");

// Creates a real kind cluster (~30s); needs Docker, kind, and kubectl. The
// pods run a pre-built image; these cases assert on the applied objects, not
// on pod readiness.
describe(
  "Kubernetes Deployment on kind",
  {
    tags: [
      "provider:kubernetes",
      "provider:kubernetes:deployment",
      "provider:kubernetes:localcluster",
      "live",
    ],
  },
  () => {
    let cluster: KindCluster;
    const image = "registry.k8s.io/pause:3.10";
    const ns = ["--namespace", "default"];
    const objectsOf = (name: string) =>
      Effect.all({
        serviceAccount: kubectlGet(cluster, ["serviceaccount", name, ...ns]),
        deployment: kubectlGet(cluster, ["deployment", name, ...ns]),
        service: kubectlGet(cluster, ["service", name, ...ns]),
      });

    beforeAll(
      Effect.gen(function* () {
        yield* kindStack.destroy();
        cluster = yield* kindStack.deploy(KindTestCluster("deployment", 5064));
      }),
      { timeout: 300_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.suspend(() => destroyKindStack(kindStack, cluster)),
      { timeout: 180_000 },
    );

    test.provider(
      "Redacted env values reach the container unwrapped",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const token = "deployment-token-sentinel";
          const nested = "deployment-nested-sentinel";
          yield* stack.deploy(
            Kubernetes.Deployment("SecretEnv", {
              cluster: cluster.connection,
              name: "secret-env",
              image,
              port: 8080,
              serviceType: "ClusterIP",
              env: {
                TOKEN: Redacted.make(token),
                CONFIG: Redacted.make({ nested }),
              },
            }),
          );

          const { deployment } = yield* objectsOf("secret-env");
          const env = Object.fromEntries(
            (
              deployment.spec.template.spec.containers[0].env as { name: string; value: string }[]
            ).map((entry) => [entry.name, entry.value]),
          );
          expect(env.TOKEN).toBe(token);
          expect(env.CONFIG).toBe(JSON.stringify({ nested }));

          yield* stack.destroy();
          expect(yield* objectsOf("secret-env")).toEqual({
            serviceAccount: undefined,
            deployment: undefined,
            service: undefined,
          });
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "destroy surfaces a 403 and leaves the objects in place",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const account = "deployment-no-delete";
          const rules = (verbs: string[]) => [
            { apiGroups: [""], resources: ["serviceaccounts", "services"], verbs },
            { apiGroups: ["apps"], resources: ["deployments"], verbs },
          ];
          const restricted = yield* restrictedConnection(
            cluster,
            account,
            rules(["get", "list", "create", "patch", "update"]),
          );
          yield* stack.deploy(
            Kubernetes.Deployment("Kept", {
              cluster: restricted,
              name: "kept",
              image,
              port: 8080,
              serviceType: "ClusterIP",
            }),
          );

          const exit = yield* Effect.exit(stack.destroy());
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("403");
          }
          const kept = yield* objectsOf("kept");
          expect(kept.deployment).toBeDefined();
          expect(kept.service).toBeDefined();

          // Granting delete lets the same destroy converge.
          yield* updateRole(
            cluster,
            account,
            rules(["get", "list", "create", "patch", "update", "delete"]),
          );
          yield* stack
            .destroy()
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 5 }));
          expect(yield* objectsOf("kept")).toEqual({
            serviceAccount: undefined,
            deployment: undefined,
            service: undefined,
          });
          yield* removeRbac(cluster, account);
        }),
      { timeout: 120_000 },
    );
  },
);

// Full end-to-end (gated). An EKS Auto Mode cluster takes ~10–15 min to
// provision, plus image build/push, pod scheduling, and NLB provisioning —
// well beyond the routine speed-doctrine ceiling. Skip it under `--fast`.
//
// It deploys, in two phases (refs read committed stack state, not the in-flight
// plan): (1) a public network + a `compute: "auto"` cluster (the provider owns
// the cluster/node IAM roles); (2) the same infra + the `Deployment` fixture,
// which binds DynamoDB `PutItem`. The bound policy lands on the generated
// pod-identity role and the table name is injected into the pod; the pod
// resolves credentials via the EKS Pod Identity container-credentials chain.
// The test curls the LoadBalancer `/put` route, then asserts the item was
// written by reading it back out-of-band through the DynamoDB API — proving
// the binding, pod identity, image pipeline, and server-side-apply path in one
// shot.
//
// NOTE: this path has not been run green live in this factory wave (cluster
// create alone exceeds the agent budget). It is gated + skip-clean; run on an
// account with Auto Mode Pod Identity unless `--fast` is set.

// Cluster declared at a TOP-LEVEL logical id so the fixture can resolve it
// with `Cluster.ref("EksHostCluster")` (no namespace nesting). `compute:
// "auto"` exercises the AutoCluster fold-in: the provider creates and owns the
// cluster + node IAM roles.
const infra = Effect.gen(function* () {
  const network = yield* Network("EksHostNetwork", {
    cidrBlock: "10.84.0.0/16",
    availabilityZones: 2,
  });

  const cluster = yield* Cluster("EksHostCluster", {
    compute: "auto",
    resourcesVpcConfig: {
      subnetIds: network.publicSubnetIds,
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
    },
  });

  return { cluster, network };
});

const sharedStack = Core.scratchStack(testOptions, "EksServerHost");

describe.skipIf(!!process.env.FAST)(
  "Kubernetes Deployment E2E",
  {
    tags: [
      "provider:aws",
      "provider:aws:dynamodb",
      "provider:aws:ec2",
      "provider:aws:eks",
      "provider:kubernetes",
      "provider:kubernetes:deployment",
      "provider:kubernetes:helmchart",
      "live",
    ],
  },
  () => {
    let baseUrl: string;
    let helmRelease: Kubernetes.HelmChart["Attributes"];
    let helmCluster: Cluster["Attributes"];

    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        // Phase 1: cluster + network only.
        yield* sharedStack.deploy(infra);
        // Phase 2: same infra + the Deployment fixture (refs the cluster) +
        // a HelmChart rendering the local fixture chart onto the cluster.
        const { host, cluster, release } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const { cluster } = yield* infra;
            const release = yield* Kubernetes.HelmChart("E2EHelmChart", {
              cluster,
              chart: `${import.meta.dirname}/fixtures/chart`,
              values: { message: "helm-e2e", secondConfigMap: { enabled: true } },
            });
            const host = yield* EksHostApi;
            return { host, cluster, release };
          }),
        );
        helmRelease = release;
        helmCluster = cluster;
        // `url` is a full URL (`http://<nlb-hostname>:<port>` — the NLB
        // listener is the Service port, not 80).
        expect(host.url).toBeTruthy();
        baseUrl = host.url!.replace(/\/+$/, "");

        // NLB DNS + pod readiness ramp — retry /health.
        yield* HttpClient.get(`${baseUrl}/health`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`/health ${res.status}`)),
          ),
          Effect.tapError((e) => Effect.logWarning(String(e))),
          Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 60 }),
        );
      }),
      // Cluster create (~18 min) + image build/push + Auto Mode node launch +
      // NLB provisioning/DNS + URL readiness poll (~5–10 min) routinely total
      // 35+ min end-to-end.
      { timeout: 2_700_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    test.provider(
      "bound DynamoDB PutItem writes an item from inside the pod",
      () =>
        Effect.gen(function* () {
          // Deterministic id: the table is created fresh by this suite's deploy
          // (beforeAll starts with a destroy), so no stale item can pre-exist,
          // and a stable id keeps re-runs convergent instead of accreting items.
          const itemId = "eks-deployment-put-item";
          const res = yield* HttpClient.get(`${baseUrl}/put?id=${itemId}`).pipe(
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
          );
          expect(res.status).toBe(200);
          const body = (yield* res.json) as { written: string; table: string };
          expect(body.written).toBe(itemId);

          // Prove the binding actually reached DynamoDB: read the item back
          // out-of-band via the control-plane API.
          const got = yield* dynamodb
            .getItem({ TableName: body.table, Key: { pk: { S: itemId } } })
            .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }));
          expect(got.Item?.pk?.S).toBe(itemId);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "HelmChart renders and applies its objects onto the cluster",
      () =>
        Effect.gen(function* () {
          // The chart rendered both ConfigMaps (the conditional one was
          // toggled on via values) into the default namespace.
          expect(helmRelease.objects).toHaveLength(2);
          expect(helmRelease.namespace).toBe("default");
          // The generic attributes persist the cluster connection for
          // adapter-based delete.
          expect(helmRelease.connection.auth.kind).toBe("aws-eks");

          // Read the primary ConfigMap back out-of-band through the
          // Kubernetes API and prove the values reached the cluster.
          const configRef = helmRelease.objects.find((object) => object.name.endsWith("-config"))!;
          expect(configRef).toBeDefined();
          const transport = yield* makeEksTransport({
            clusterName: helmCluster.clusterName,
            endpoint: helmCluster.endpoint!,
            certificateAuthorityData: helmCluster.certificateAuthorityData!,
          });
          const applied = (yield* readObject({ transport, object: configRef })) as
            | { data?: Record<string, string> }
            | undefined;
          expect(applied?.data?.message).toBe("helm-e2e");
          expect(applied?.data?.release).toBe(helmRelease.releaseName);
        }),
      { timeout: 120_000 },
    );
  },
);
