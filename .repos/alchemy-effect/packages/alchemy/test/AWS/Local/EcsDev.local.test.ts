/**
 * Mode-scoped local dev for ECS: `Test.make({ dev: true })` routes the
 * dualized `ECS.Cluster` / `ECS.Task` (and `ECS.TaskDefinition` /
 * `ECS.Service`) to the floci emulator, where tasks run as REAL docker
 * containers.
 *
 * Proof structure (mirrors DataPlane.local.test.ts):
 *   - attrs carry the dummy account (`:000000000000:` ARNs) and the
 *     `.localhost:` ECR repository URI — the live cloud can never mint
 *     these;
 *   - persisted state rows are stamped `providerMode: "local"`;
 *   - out-of-band raw HTTP against the emulator gateway runs the deployed
 *     task definition (RunTask) and observes it RUNNING as a real docker
 *     container (`docker ps` shows `floci-ecs-<taskId>-…`);
 *   - the container round-trips HTTP: floci publishes the LITERAL host
 *     port for bridge-mode port mappings (awsvpc tasks are expose-only
 *     when floci itself runs in a container), so the fixture uses
 *     `networkMode: "bridge"` and the test fetches
 *     `http://localhost:<port>` for the marker;
 *   - `stack.destroy()` drains the cluster (the running task is stopped
 *     and its container removed) and deletes the task definition, ECR
 *     repository, log group, and IAM roles — all verified gone.
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import * as AWS from "@/AWS";
import { State, type ResourceState } from "@/State";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { spawnSync } from "node:child_process";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import EcsDevMainTask from "./fixtures/ecs-dev/main-task.ts";
import { dockerAvailable, rawAwsJson } from "./fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const contextDir = `${import.meta.dirname}/fixtures/ecs-dev`;

/** Must match the port baked into fixtures/ecs-dev/Dockerfile. */
const CONTEXT_PORT = 17356;
/** Must match the `port` on fixtures/ecs-dev/main-task.ts. */
const MAIN_PORT = 17357;
/** Must match the port baked into fixtures/ecs-reload/Dockerfile. */
const RELOAD_PORT = 17358;
/** Must match the port baked into fixtures/ecs-svc/Dockerfile. */
const SVC_PORT = 17359;
/** Must match the default port in fixtures/ecs-reload-main/server.ts. */
const MAIN_RELOAD_PORT = 17360;
/** Must match the port baked into fixtures/ecs-env/Dockerfile. */
const ENV_PORT = 17361;
/** Must match the port baked into fixtures/ecs-ext/Dockerfile.ecs. */
const EXT_PORT = 17363;

const FLOCI_REGION = "us-east-1";

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn,
  })) as ResourceState | undefined;
});

class RunTaskRejected extends Data.TaggedError("RunTaskRejected")<{
  readonly status: number;
}> {}

/** Raw ECS operation against the emulator gateway (out-of-band). */
const rawEcs = (action: string, body: Record<string, unknown>) =>
  rawAwsJson({
    service: "ecs",
    region: FLOCI_REGION,
    target: `AmazonEC2ContainerServiceV20141113.${action}`,
    contentType: "application/x-amz-json-1.1",
    body,
  });

/** Names of the docker containers currently running on the host daemon. */
const runningContainerNames = Effect.sync(
  () =>
    spawnSync("docker", ["ps", "--format", "{{.Names}}"], {
      encoding: "utf8",
      timeout: 15_000,
    }).stdout ?? "",
);

/** `arn:aws:ecs:…:task/<cluster>/<taskId>` → `<taskId>`. */
const taskIdOfArn = (arn: string) => arn.split("/").pop()!;

/**
 * The emulator runs task containers on THIS machine — build for the host
 * architecture so the image runs natively instead of under qemu.
 */
const hostRuntimePlatform = {
  cpuArchitecture:
    process.arch === "arm64" ? ("ARM64" as const) : ("X86_64" as const),
  operatingSystemFamily: "LINUX" as const,
};

/**
 * Deploy → RunTask → assert RUNNING container + HTTP marker → destroy →
 * assert everything (including the docker container) is gone. Shared by the
 * context-Dockerfile and bundled-main cases.
 */
const runTaskRoundTrip = Effect.fn(function* (options: {
  clusterName: string;
  taskDefinitionArn: string;
  port: number;
  marker: string;
}) {
  const client = yield* HttpClient.HttpClient;

  // Out-of-band: run the deployed task definition on the deployed cluster
  // through the raw gateway API. floci launches a REAL docker container.
  // Full-suite load can 400 the first RunTask; retry until the emulator
  // accepts it rather than failing the whole file.
  const runResponse = yield* rawEcs("RunTask", {
    cluster: options.clusterName,
    taskDefinition: options.taskDefinitionArn,
    count: 1,
    launchType: "EC2",
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new RunTaskRejected({ status: response.status })),
    ),
    Effect.retry({
      while: (e) => e._tag === "RunTaskRejected",
      times: 8,
      schedule: Schedule.exponential("500 millis"),
    }),
  );
  const run = (yield* runResponse.json) as {
    tasks?: { taskArn?: string; lastStatus?: string }[];
    failures?: unknown[];
  };
  expect(run.failures ?? []).toEqual([]);
  const taskArn = run.tasks?.[0]?.taskArn;
  expect(taskArn).toBeTruthy();
  const taskId = taskIdOfArn(taskArn!);

  // DescribeTasks observes the task RUNNING…
  const described = yield* rawEcs("DescribeTasks", {
    cluster: options.clusterName,
    tasks: [taskArn],
  });
  expect(described.status).toBe(200);
  const tasks = (yield* described.json) as {
    tasks?: { lastStatus?: string }[];
  };
  expect(tasks.tasks?.[0]?.lastStatus).toBe("RUNNING");

  // …and the task is a REAL container on the host docker daemon
  // (`floci-ecs-<taskId>-<containerName>`).
  expect(yield* runningContainerNames).toContain(`floci-ecs-${taskId}`);

  // Round-trip HTTP to the served marker. Bridge-mode port mappings are
  // published literally on the docker host, so the container is reachable
  // at localhost:<port>. (floci's DescribeTasks networkBindings mis-report
  // the hostPort as the containerPort, so the literal port — equal by
  // construction in the Task's port mapping — is the reliable address.)
  const body = yield* client.get(`http://localhost:${options.port}/`).pipe(
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
    Effect.flatMap((response) => response.text),
  );
  expect(body).toContain(options.marker);

  return { taskId };
});

/**
 * Bounded poll of `http://localhost:<port>/` until the marker serves.
 * Connection failures (the swap window between the old container stopping
 * and the replacement serving) are retried; a stale marker repeats.
 */
const pollMarker = Effect.fn(function* (options: {
  port: number;
  marker: string;
  times?: number;
  /** Path to poll (default `/`). */
  path?: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const times = options.times ?? 60;
  const body = yield* client
    .get(`http://localhost:${options.port}${options.path ?? "/"}`)
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.retry({
        while: (): boolean => true,
        schedule: Schedule.spaced("2 seconds"),
        times,
      }),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (b): boolean => b.includes(options.marker),
        times,
      }),
    );
  expect(body).toContain(options.marker);
});

/**
 * Post-destroy (hot-reload variants, where the swap replaced the original
 * task): observe until no running container belongs to the family's primary
 * container (`floci-ecs-<taskId>-<containerName>`), then assert the cluster
 * and task definition are gone from the emulator.
 */
const assertFamilyTornDown = Effect.fn(function* (options: {
  clusterName: string;
  taskDefinitionArn: string;
  containerName: string;
}) {
  yield* runningContainerNames.pipe(
    Effect.flatMap((names) =>
      names
        .split("\n")
        .some(
          (name) =>
            name.startsWith("floci-ecs-") &&
            name.endsWith(`-${options.containerName}`),
        )
        ? Effect.fail(new Error("family container still running"))
        : Effect.void,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
  );

  const clusters = (yield* (yield* rawEcs("DescribeClusters", {
    clusters: [options.clusterName],
  })).json) as { clusters?: { status?: string }[] };
  const active = (clusters.clusters ?? []).filter(
    (cluster) => cluster.status !== "INACTIVE",
  );
  expect(active).toEqual([]);

  const definition = yield* rawEcs("DescribeTaskDefinition", {
    taskDefinition: options.taskDefinitionArn,
  });
  expect(definition.status).toBe(400); // ClientException: unable to describe
});

/** Post-destroy: task container gone, cluster gone, task definition gone. */
const assertTornDown = Effect.fn(function* (options: {
  clusterName: string;
  taskDefinitionArn: string;
  taskId: string;
}) {
  // The running task's container was stopped and removed by the cluster
  // delete (observe until the daemon agrees — stop is asynchronous).
  yield* runningContainerNames.pipe(
    Effect.flatMap((names) =>
      names.includes(`floci-ecs-${options.taskId}`)
        ? Effect.fail(new Error("task container still running"))
        : Effect.void,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

  // The cluster is gone (or INACTIVE) in the emulator.
  const clusters = (yield* (yield* rawEcs("DescribeClusters", {
    clusters: [options.clusterName],
  })).json) as { clusters?: { status?: string }[] };
  const active = (clusters.clusters ?? []).filter(
    (cluster) => cluster.status !== "INACTIVE",
  );
  expect(active).toEqual([]);

  // The task definition revision is gone.
  const definition = yield* rawEcs("DescribeTaskDefinition", {
    taskDefinition: options.taskDefinitionArn,
  });
  expect(definition.status).toBe(400); // ClientException: unable to describe
});

// Sequential on purpose: each test runs a `docker buildx build`, and
// concurrent builds multiply pressure on Docker Desktop's shared
// `docker-credential-desktop` helper, which can wedge machine-wide under
// concurrent access (the same helper-race class documented on
// `Docker.image.push`). One build at a time keeps this file off that path.
describe.sequential("EcsDev", () => {
  test.provider.skipIf(!dockerAvailable)(
    "dev mode runs a context-Dockerfile ECS task as a real local container",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            // Propless instantiation on purpose: pins the `news ?? {}`
            // normalization in the Cluster reconciler (every ClusterProps
            // field is optional, so `Cluster("Id")` is legal).
            const cluster = yield* AWS.ECS.Cluster("EcsDevCluster");
            const task = yield* AWS.ECS.Task("EcsDevTask", {
              context: contextDir,
              port: CONTEXT_PORT,
              cpu: 256,
              memory: 512,
              // Bridge mode publishes the literal host port — the only
              // host-reachable mode when floci runs inside a container.
              networkMode: "bridge",
              requiresCompatibilities: ["EC2"],
              runtimePlatform: hostRuntimePlatform,
            });
            return { cluster, task };
          }),
        );

        // --- Emulator-shaped identity: the live cloud can never mint these.
        expect(outputs.cluster.clusterArn).toContain(":000000000000:");
        expect(outputs.task.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.task.taskRoleArn).toContain("::000000000000:");
        expect(outputs.task.executionRoleArn).toContain("::000000000000:");
        // The image was pushed to floci's loopback ECR registry.
        expect(outputs.task.repositoryUri).toContain(".localhost:");
        expect(outputs.task.imageUri).toContain(".localhost:");

        // --- Stamped-mode proof.
        for (const fqn of ["EcsDevCluster", "EcsDevTask"]) {
          const row = yield* getState(fqn);
          expect(`${fqn}:${row?.status}`).toBe(`${fqn}:created`);
          expect(`${fqn}:${row?.providerMode}`).toBe(`${fqn}:local`);
        }

        // --- Run the task: real container, HTTP marker round-trip.
        const { taskId } = yield* runTaskRoundTrip({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          port: CONTEXT_PORT,
          marker: "ecs-dev-local-marker",
        });

        // --- Destroy: the cluster delete stops the running task (container
        // removed), and the task delete sweeps the definition + repository.
        yield* stack.destroy();

        yield* assertTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          taskId,
        });

        // The ECR repository holding the built image is gone from the
        // emulator's registry too.
        const repositories = yield* rawAwsJson({
          service: "ecr",
          region: FLOCI_REGION,
          target: "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
          contentType: "application/x-amz-json-1.1",
          body: { repositoryNames: [outputs.task.repositoryName] },
        });
        expect(repositories.status).toBe(400); // RepositoryNotFoundException
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!dockerAvailable)(
    "dev mode bundles a main-program ECS task and pushes through the local ECR registry",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("EcsDevMainCluster", {});
            const task = yield* EcsDevMainTask;
            return { cluster, task };
          }),
        );

        expect(outputs.cluster.clusterArn).toContain(":000000000000:");
        expect(outputs.task.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.task.repositoryUri).toContain(".localhost:");

        for (const fqn of ["EcsDevMainCluster", "EcsDevMainTask"]) {
          const row = yield* getState(fqn);
          expect(`${fqn}:${row?.status}`).toBe(`${fqn}:created`);
          expect(`${fqn}:${row?.providerMode}`).toBe(`${fqn}:local`);
        }

        const { taskId } = yield* runTaskRoundTrip({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          port: MAIN_PORT,
          marker: "ecs-dev-main-marker",
        });

        yield* stack.destroy();

        yield* assertTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          taskId,
        });
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!dockerAvailable)(
    "hot reloads a context-Dockerfile task without a deploy",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* stack.destroy();

        // Clone the fixture so the hot-reload rewrite never touches the
        // repo tree.
        const clone = yield* cloneFixture(
          `${import.meta.dirname}/fixtures/ecs-reload`,
          { prefix: "ecs-reload-" },
        );

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("EcsReloadCluster");
            const task = yield* AWS.ECS.Task("EcsReloadTask", {
              context: clone,
              port: RELOAD_PORT,
              cpu: 256,
              memory: 512,
              networkMode: "bridge",
              requiresCompatibilities: ["EC2"],
              runtimePlatform: hostRuntimePlatform,
            });
            return { cluster, task };
          }),
        );
        expect(outputs.task.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.task.repositoryUri).toContain(".localhost:");

        // Run the deployed revision out-of-band; marker v1 serves.
        yield* runTaskRoundTrip({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          port: RELOAD_PORT,
          marker: "ecs-reload-v1",
        });

        // Hot reload: rewrite the CLONED context — no deploy in between.
        // The sidecar watch loop rebuilds the image, pushes the new
        // content-hash tag, registers a new task definition revision, and
        // restarts the running standalone task on it.
        const swapStartedAt = Date.now();
        yield* fs.writeFileString(
          path.join(clone, "index.html"),
          "ecs-reload-v2\n",
        );
        yield* pollMarker({
          port: RELOAD_PORT,
          marker: "ecs-reload-v2",
          times: 90,
        });
        yield* Effect.log(
          `context task hot reload observed in ${Date.now() - swapStartedAt}ms`,
        );

        yield* stack.destroy();
        yield* assertFamilyTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          containerName: outputs.task.containerName,
        });
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!dockerAvailable)(
    "hot reloads a bundled-main task without a deploy",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* stack.destroy();

        const clone = yield* cloneFixture(
          `${import.meta.dirname}/fixtures/ecs-reload-main`,
          { prefix: "ecs-reload-main-" },
        );
        const mainPath = path.join(clone, "server.ts");

        const program = Effect.gen(function* () {
          const cluster = yield* AWS.ECS.Cluster("EcsReloadMainCluster");
          // Declared WITHOUT an inline impl — the platform marks it
          // external and the bundle runs as-is (a plain Bun server).
          const task = yield* AWS.ECS.Task("EcsReloadMainTask", {
            main: mainPath,
            image: "oven/bun:1",
            port: MAIN_RELOAD_PORT,
            cpu: 256,
            memory: 512,
            networkMode: "bridge",
            requiresCompatibilities: ["EC2"],
            runtimePlatform: hostRuntimePlatform,
          });
          return { cluster, task };
        });
        const outputs = yield* stack.deploy(program);
        expect(outputs.task.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.task.repositoryUri).toContain(".localhost:");

        yield* runTaskRoundTrip({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          port: MAIN_RELOAD_PORT,
          marker: "ecs-reload-main-v1",
        });

        // Hot reload: rewrite the CLONED program source. The sidecar's
        // `Bundle.watch` (the deploy's exact rolldown module graph)
        // triggers the rebuild → push → re-register → restart.
        const source = yield* fs.readFileString(mainPath);
        const swapStartedAt = Date.now();
        yield* fs.writeFileString(
          mainPath,
          source.replace("ecs-reload-main-v1", "ecs-reload-main-v2"),
        );
        yield* pollMarker({
          port: MAIN_RELOAD_PORT,
          marker: "ecs-reload-main-v2",
          times: 90,
        });
        yield* Effect.log(
          `bundled-main task hot reload observed in ${Date.now() - swapStartedAt}ms`,
        );

        // A REPLAN after the watcher's swap must surface it. Persisted state
        // still carries v1's code hash (the watcher updates the emulator and
        // the sidecar's in-memory attrs, not the state store), so the dev
        // diff plans an update — not a noop — and the fresh attrs flow to
        // stack outputs. The reported bug had this replan noop, so
        // `task.code.hash` never advanced and Actions keyed on it stayed
        // skipped after a transitive-import change.
        const replanned = yield* stack.deploy(program);
        expect(replanned.task.code.hash).not.toBe(outputs.task.code.hash);
        // And a second replan with nothing new IS a noop-equivalent: the
        // attrs are settled, the hash stable.
        const settled = yield* stack.deploy(program);
        expect(settled.task.code.hash).toBe(replanned.task.code.hash);

        yield* stack.destroy();
        yield* assertFamilyTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          containerName: outputs.task.containerName,
        });
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!dockerAvailable)(
    "dev mode runs an image-owning ECS Service with hot reload",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* stack.destroy();

        const clone = yield* cloneFixture(
          `${import.meta.dirname}/fixtures/ecs-svc`,
          { prefix: "ecs-svc-" },
        );

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("EcsDevSvcCluster");
            const service = yield* AWS.ECS.Service("EcsDevService", {
              cluster,
              context: clone,
              port: SVC_PORT,
              cpu: 256,
              memory: 512,
              // Bridge mode publishes the literal host port — the only
              // host-reachable mode when floci runs inside a container
              // (managed ALB ingress is out of scope in dev: floci binds
              // listener sockets inside its own container, and the managed
              // `alchemy-floci` container only exposes the gateway port).
              networkMode: "bridge",
              requiresCompatibilities: ["EC2"],
              launchType: "EC2",
              desiredCount: 1,
              runtimePlatform: hostRuntimePlatform,
              deploymentStabilizationTimeout: "3 minutes",
            });
            return { cluster, service };
          }),
        );

        // Emulator-shaped identity + stamped-mode proof.
        expect(outputs.service.serviceArn).toContain(":000000000000:");
        expect(outputs.service.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.service.repositoryUri).toContain(".localhost:");
        expect(outputs.service.status).toBe("ACTIVE");
        for (const fqn of ["EcsDevSvcCluster", "EcsDevService"]) {
          const row = yield* getState(fqn);
          expect(`${fqn}:${row?.status}`).toBe(`${fqn}:created`);
          expect(`${fqn}:${row?.providerMode}`).toBe(`${fqn}:local`);
        }

        // The floci service scheduler launched the task itself — a REAL
        // container serving the marker (no manual RunTask).
        yield* pollMarker({ port: SVC_PORT, marker: "ecs-svc-v1", times: 60 });
        expect(yield* runningContainerNames).toContain(
          `-${outputs.service.containerName!}`,
        );

        // Hot reload: rewrite the CLONED context — no deploy in between.
        // The sidecar watcher rebuilds + pushes the new content-hash tag,
        // re-reconciles (updateService onto the new revision), and stops
        // the old-revision task; the floci scheduler relaunches it.
        const swapStartedAt = Date.now();
        yield* fs.writeFileString(
          path.join(clone, "index.html"),
          "ecs-svc-v2\n",
        );
        yield* pollMarker({ port: SVC_PORT, marker: "ecs-svc-v2", times: 90 });
        yield* Effect.log(
          `service hot reload observed in ${Date.now() - swapStartedAt}ms`,
        );

        // Destroy drains the service (desiredCount 0 → tasks stopped),
        // deletes it, then sweeps the task-definition infrastructure.
        yield* stack.destroy();
        yield* assertFamilyTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.service.taskDefinitionArn,
          containerName: outputs.service.containerName!,
        });
        const services = (yield* (yield* rawEcs("DescribeServices", {
          cluster: outputs.cluster.clusterName,
          services: [outputs.service.serviceName],
        })).json) as { services?: { status?: string }[] };
        const activeServices = (services.services ?? []).filter(
          (service) => service.status === "ACTIVE",
        );
        expect(activeServices).toEqual([]);
      }),
    { timeout: 300_000 },
  );

  /**
   * A PROP-driven update — no file event — must roll the service's running
   * containers onto the new task-definition revision. Regression: restart
   * logic lived only in the file-watch trigger, so an engine reconcile
   * (env change, inline-dockerfile edit) registered a new revision and
   * `updateService`d onto it while the container kept serving the old one
   * until the next source edit (`onReconciled` in DevWatchProvider).
   */
  test.provider.skipIf(!dockerAvailable)(
    "rolls a service task on a prop-only env update",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const clone = yield* cloneFixture(
          `${import.meta.dirname}/fixtures/ecs-env`,
          { prefix: "ecs-env-" },
        );

        const declare = (env: string) =>
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("EcsEnvCluster");
            const service = yield* AWS.ECS.Service("EcsEnvService", {
              cluster,
              context: clone,
              port: ENV_PORT,
              cpu: 256,
              memory: 512,
              networkMode: "bridge",
              requiresCompatibilities: ["EC2"],
              launchType: "EC2",
              desiredCount: 1,
              runtimePlatform: hostRuntimePlatform,
              deploymentStabilizationTimeout: "3 minutes",
              env: { ROLL_ENV: env },
            });
            return { cluster, service };
          });

        const outputs = yield* stack.deploy(declare("roll-env-v1"));
        yield* pollMarker({
          port: ENV_PORT,
          marker: "roll-env-v1",
          path: "/env.txt",
          times: 90,
        });

        // The prop change: same fixture bytes, only the env differs. The
        // engine registers a new revision; the running container must roll.
        const swapStartedAt = Date.now();
        const updated = yield* stack.deploy(declare("roll-env-v2"));
        expect(updated.service.taskDefinitionArn).not.toBe(
          outputs.service.taskDefinitionArn,
        );
        yield* pollMarker({
          port: ENV_PORT,
          marker: "roll-env-v2",
          path: "/env.txt",
          times: 90,
        });
        yield* Effect.log(
          `prop-only service roll observed in ${Date.now() - swapStartedAt}ms`,
        );

        yield* stack.destroy();
        yield* assertFamilyTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: updated.service.taskDefinitionArn,
          containerName: updated.service.containerName!,
        });
      }),
    { timeout: 600_000 },
  );
  /**
   * A `dockerfile` PATH that lives OUTSIDE the build context: the watcher
   * must watch the Dockerfile's own directory in addition to the context
   * (the `imageSourceTrigger` outside-context branch — previously never
   * exercised by any test), and an edit to the Dockerfile itself must
   * rebuild + roll with no deploy.
   */
  test.provider.skipIf(!dockerAvailable)(
    "hot reloads a service whose Dockerfile lives outside the build context",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const clone = yield* cloneFixture(
          `${import.meta.dirname}/fixtures/ecs-ext`,
          { prefix: "ecs-ext-" },
        );

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("EcsExtCluster");
            const service = yield* AWS.ECS.Service("EcsExtService", {
              cluster,
              context: path.join(clone, "site"),
              dockerfile: path.join(clone, "Dockerfile.ecs"),
              port: EXT_PORT,
              cpu: 256,
              memory: 512,
              networkMode: "bridge",
              requiresCompatibilities: ["EC2"],
              launchType: "EC2",
              desiredCount: 1,
              runtimePlatform: hostRuntimePlatform,
              deploymentStabilizationTimeout: "3 minutes",
            });
            return { cluster, service };
          }),
        );

        yield* pollMarker({
          port: EXT_PORT,
          marker: "ecs-ext-content-v1",
          times: 90,
        });
        yield* pollMarker({
          port: EXT_PORT,
          marker: "ecs-ext-baked-v1",
          path: "/baked.txt",
          times: 60,
        });

        // Edit the OUT-OF-CONTEXT Dockerfile — no deploy.
        const swapStartedAt = Date.now();
        const dockerfile = yield* fs.readFileString(
          path.join(clone, "Dockerfile.ecs"),
        );
        yield* fs.writeFileString(
          path.join(clone, "Dockerfile.ecs"),
          dockerfile.replace("ecs-ext-baked-v1", "ecs-ext-baked-v2"),
        );
        yield* pollMarker({
          port: EXT_PORT,
          marker: "ecs-ext-baked-v2",
          path: "/baked.txt",
          times: 90,
        });
        yield* Effect.log(
          `out-of-context Dockerfile reload observed in ${Date.now() - swapStartedAt}ms`,
        );

        // A context file edit still reloads too.
        yield* fs.writeFileString(
          path.join(clone, "site", "index.html"),
          "ecs-ext-content-v2\n",
        );
        yield* pollMarker({
          port: EXT_PORT,
          marker: "ecs-ext-content-v2",
          times: 90,
        });

        yield* stack.destroy();
        yield* assertFamilyTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.service.taskDefinitionArn,
          containerName: outputs.service.containerName!,
        });
      }),
    { timeout: 600_000 },
  );
}); // describe.sequential("EcsDev")
