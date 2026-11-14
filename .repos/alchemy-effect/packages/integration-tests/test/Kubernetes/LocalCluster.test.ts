import * as Kubernetes from "@alchemy.run/kubernetes";
import { connectCluster, readObject } from "@alchemy.run/kubernetes/Client";
import {
  kindClusterConfig,
  kindConfigOf,
  REGISTRY_CONTAINERD_PATCH,
} from "@alchemy.run/kubernetes/internal/kind";
import { imagePlatformOf } from "@alchemy.run/kubernetes/internal/workload";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import { kubectl } from "./fixtures/kind.ts";
import LocalDockerfileJob, { BUILD_SECRET } from "./fixtures/local-dockerfile-job.ts";
import LocalEffectJob from "./fixtures/local-job.ts";
import LocalEffectServer from "./fixtures/local-server.ts";
import { TestLocalCluster } from "./fixtures/local.ts";

const testOptions = { providers: Kubernetes.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

const tags = ["provider:kubernetes", "provider:kubernetes:localcluster"];

const attrs = (name: string): Kubernetes.LocalCluster["Attributes"] => ({
  name,
  context: `kind-${name}`,
  kubeconfig: undefined,
  registry: { server: "localhost:5001" },
  registryContainer: `${name}-registry`,
  architecture: "arm64",
  connection: {
    auth: { kind: "kubeconfig", context: `kind-${name}` },
    registry: { server: "localhost:5001" },
    architecture: "arm64",
  },
});

test.provider(
  "diff replaces the cluster when its name or node image changes",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Kubernetes.LocalCluster);
      const base = {
        id: "Cluster",
        fqn: "Cluster",
        instanceId: "instance",
        oldBindings: [],
        newBindings: [],
        output: attrs("dev"),
      };
      const renamed = yield* provider.diff!({
        ...base,
        olds: { name: "dev" },
        news: { name: "other" },
      });
      expect(renamed?.action).toBe("replace");

      const reimaged = yield* provider.diff!({
        ...base,
        olds: { name: "dev" },
        news: { name: "dev", nodeImage: "kindest/node:v1.33.1" },
      });
      expect(reimaged?.action).toBe("replace");

      const ports = [{ containerPort: 30080, hostPort: 8080 }];
      const reconfigured = yield* provider.diff!({
        ...base,
        olds: { name: "dev" },
        news: {
          name: "dev",
          nodes: [{ role: "control-plane", extraPortMappings: ports }],
        },
      });
      expect(reconfigured?.action).toBe("replace");

      const sameConfig = yield* provider.diff!({
        ...base,
        olds: {
          name: "dev",
          nodes: [{ role: "control-plane", extraPortMappings: ports }],
        },
        news: {
          name: "dev",
          nodes: [{ extraPortMappings: ports, role: "control-plane" }],
        },
      });
      expect(sameConfig).toBeUndefined();

      const moved = yield* provider.diff!({
        ...base,
        olds: { name: "dev" },
        news: { name: "dev", registryPort: 5002 },
      });
      expect(moved).toBeUndefined();
    }),
  { tags: ["unit", ...tags, "local"] },
);

test.provider(
  "user kind config is kept and the registry patch is appended",
  () =>
    Effect.sync(() => {
      expect(kindClusterConfig(kindConfigOf({ name: "dev" }))).toEqual({
        kind: "Cluster",
        apiVersion: "kind.x-k8s.io/v1alpha4",
        containerdConfigPatches: [REGISTRY_CONTAINERD_PATCH],
      });
      const config = kindClusterConfig(
        kindConfigOf({
          name: "dev",
          registryPort: 5002,
          nodeImage: "kindest/node:v1.33.1",
          nodes: [
            {
              role: "control-plane",
              extraPortMappings: [{ containerPort: 80, hostPort: 8080 }],
            },
            { role: "worker" },
          ],
          networking: { podSubnet: "10.244.0.0/16" },
          containerdConfigPatches: ["# user patch"],
        }),
      );
      // Alchemy's own props never reach kind's config.
      expect(config.name).toBeUndefined();
      expect(config.registryPort).toBeUndefined();
      expect(config.nodeImage).toBeUndefined();
      expect(config.networking).toEqual({ podSubnet: "10.244.0.0/16" });
      expect(config.kind).toBe("Cluster");
      expect(config.nodes).toHaveLength(2);
      expect(config.containerdConfigPatches).toEqual(["# user patch", REGISTRY_CONTAINERD_PATCH]);
    }),
  { tags: ["unit", ...tags, "local"] },
);

test.provider(
  "workloads build for the connection's node architecture by default",
  () =>
    Effect.sync(() => {
      const connection = attrs("dev").connection;
      expect(imagePlatformOf(undefined, connection)).toBe("linux/arm64");
      expect(imagePlatformOf("amd64", connection)).toBe("linux/amd64");
      expect(imagePlatformOf(undefined, undefined)).toBe("linux/amd64");
    }),
  { tags: ["unit", ...tags, "local"] },
);

const stack = Core.scratchStack(testOptions, "LocalClusterE2E");

// Creates a real kind cluster (~30s) and builds images with Docker; needs
// Docker and the kind CLI.
describe("Kubernetes LocalCluster E2E", { tags: [...tags, "live"] }, () => {
  let cluster: Kubernetes.LocalCluster["Attributes"];
  let jobName: string;
  let dockerfileJobName: string;

  beforeAll(
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* TestLocalCluster;
          const job = yield* LocalEffectJob;
          const dockerfileJob = yield* LocalDockerfileJob;
          yield* LocalEffectServer;
          return { cluster, jobName: job.jobName, dockerfileJobName: dockerfileJob.jobName };
        }),
      );
      cluster = deployed.cluster;
      jobName = deployed.jobName;
      dockerfileJobName = deployed.dockerfileJobName;
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      yield* stack.destroy();
      // Out-of-band: the kind cluster and its registry container are gone.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const clusters = yield* spawner.lines(ChildProcess.make("kind", ["get", "clusters"]));
      expect(clusters).not.toContain(cluster.name);
      const containers = yield* spawner.lines(
        ChildProcess.make("docker", ["ps", "--all", "--format", "{{.Names}}"]),
      );
      expect(containers).not.toContain(cluster.registryContainer);
    }),
    { timeout: 180_000 },
  );

  test.provider("the cluster exposes a connection with its registry and architecture", () =>
    Effect.sync(() => {
      expect(cluster.context).toBe("kind-alchemy-test-local");
      expect(cluster.registry.server).toBe("localhost:5061");
      expect(cluster.connection.registry?.server).toBe("localhost:5061");
      expect(["amd64", "arm64"]).toContain(cluster.architecture);
    }),
  );

  test.provider(
    "an Effect Job is built into the local registry and runs to completion",
    () =>
      Effect.gen(function* () {
        const transport = yield* connectCluster(cluster.connection);
        const job = yield* readObject({
          transport,
          object: {
            apiVersion: "batch/v1",
            kind: "Job",
            name: jobName,
            namespace: "default",
          },
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (job) =>
              ((job as { status?: { succeeded?: number } }).status?.succeeded ?? 0) >= 1,
            times: 45,
          }),
        );
        const spec = job as {
          status?: { succeeded?: number };
          spec?: {
            template?: { spec?: { containers?: { image?: string }[] } };
          };
        };
        expect(spec.status?.succeeded).toBe(1);
        expect(spec.spec?.template?.spec?.containers?.[0]?.image).toMatch(/^localhost:5061\//);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "a Dockerfile Job is built with its build args and BuildKit secrets",
    () =>
      Effect.gen(function* () {
        const transport = yield* connectCluster(cluster.connection);
        yield* readObject({
          transport,
          object: {
            apiVersion: "batch/v1",
            kind: "Job",
            name: dockerfileJobName,
            namespace: "default",
          },
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (job) =>
              ((job as { status?: { succeeded?: number } }).status?.succeeded ?? 0) >= 1,
            times: 45,
          }),
        );
        // The image prints the file its build wrote: the arg, and the
        // secret's length rather than its value.
        const logs = yield* kubectl(cluster, ["logs", `job/${dockerfileJobName}`]);
        expect(logs.trim()).toBe(`hello ${BUILD_SECRET.length}`);
      }),
    { timeout: 120_000 },
  );

  // The build targets the cluster's platform, so the push must too: an
  // unscoped `docker push` from a containerd image store publishes an OCI
  // index carrying a Buildx attestation manifest, which strict consumers
  // (e.g. Lambda) reject.
  test.provider(
    "the Effect Job image is pushed as a single manifest for the cluster platform",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const transport = yield* connectCluster(cluster.connection);
        const job = (yield* readObject({
          transport,
          object: { apiVersion: "batch/v1", kind: "Job", name: jobName, namespace: "default" },
        })) as { spec?: { template?: { spec?: { containers?: { image?: string }[] } } } };
        const image = job.spec?.template?.spec?.containers?.[0]?.image ?? "";
        const match = /^localhost:5061\/(.+):([^:]+)$/.exec(image);
        expect(match).not.toBeNull();
        const [, repository, tag] = match!;

        const get = (reference: string) =>
          client
            .execute(
              HttpClientRequest.get(
                `http://localhost:5061/v2/${repository}/manifests/${reference}`,
              ).pipe(
                HttpClientRequest.setHeader(
                  "accept",
                  [
                    "application/vnd.oci.image.index.v1+json",
                    "application/vnd.oci.image.manifest.v1+json",
                    "application/vnd.docker.distribution.manifest.list.v2+json",
                    "application/vnd.docker.distribution.manifest.v2+json",
                  ].join(", "),
                ),
              ),
            )
            .pipe(Effect.flatMap((response) => response.json));

        const manifest = (yield* get(tag!)) as {
          mediaType?: string;
          config?: { digest: string };
        };
        expect(manifest.mediaType).not.toMatch(/index|manifest\.list/);
        const config = (yield* client
          .get(`http://localhost:5061/v2/${repository}/blobs/${manifest.config!.digest}`)
          .pipe(Effect.flatMap((response) => response.json))) as {
          os: string;
          architecture: string;
        };
        expect(`${config.os}/${config.architecture}`).toBe(`linux/${cluster.architecture}`);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "an Effect server Deployment becomes available",
    () =>
      Effect.gen(function* () {
        const transport = yield* connectCluster(cluster.connection);
        const deployment = yield* readObject({
          transport,
          object: {
            apiVersion: "apps/v1",
            kind: "Deployment",
            name: "local-effect-server",
            namespace: "default",
          },
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (d) =>
              ((d as { status?: { availableReplicas?: number } }).status?.availableReplicas ?? 0) >=
              1,
            times: 45,
          }),
        );
        expect(
          (deployment as { status?: { availableReplicas?: number } }).status?.availableReplicas,
        ).toBe(1);
      }),
    { timeout: 120_000 },
  );
});
