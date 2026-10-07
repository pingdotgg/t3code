import * as Alchemy from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import { connectCluster, readObject } from "alchemy/Kubernetes/internal/client";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Kubernetes.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(
  destroy(Stack).pipe(Effect.andThen(deploy(Stack)), Effect.tap(Console.log)),
  { timeout: 240_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

// The cluster the tutorial creates, reached the way `kubectl` would.
const cluster = Kubernetes.KubeConfig({ context: "kind-alchemy" });

const read = (object: {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}) =>
  connectCluster(cluster).pipe(
    Effect.flatMap((transport) => readObject({ transport, object })),
    Effect.provide(Kubernetes.builtinAdapters()),
  );

test(
  "the smoke test Job reaches podinfo and completes",
  Effect.gen(function* () {
    const { namespace, smokeTest } = yield* stack;
    const job = (yield* read({
      apiVersion: "batch/v1",
      kind: "Job",
      name: smokeTest,
      namespace,
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (job) =>
          ((job as { status?: { succeeded?: number } } | undefined)?.status
            ?.succeeded ?? 0) >= 1,
        times: 60,
      }),
    )) as { status?: { succeeded?: number } };
    expect(job.status?.succeeded).toBe(1);
  }),
  { timeout: 180_000 },
);

test(
  "podinfo, the health-check CronJob, and metrics-server are applied",
  Effect.gen(function* () {
    const { namespace, service } = yield* stack;
    const web = (yield* read({
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: service,
      namespace,
    })) as { spec?: { replicas?: number } };
    expect(web.spec?.replicas).toBe(2);

    const cronJob = (yield* read({
      apiVersion: "batch/v1",
      kind: "CronJob",
      name: "health-check",
      namespace,
    })) as { spec?: { schedule?: string } };
    expect(cronJob.spec?.schedule).toBe("*/5 * * * *");

    const metrics = yield* read({
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "metrics-server",
      namespace: "kube-system",
    });
    expect(metrics).toBeDefined();
  }),
  { timeout: 60_000 },
);
