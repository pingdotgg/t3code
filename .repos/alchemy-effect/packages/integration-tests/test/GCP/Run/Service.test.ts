import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { DataBucket, Tweets } from "./fixtures/bound-resources.ts";
import Worker from "./fixtures/container-worker.ts";
import EffectApiCaller from "./fixtures/effect-apis/caller.ts";
import BoundContainerService from "./fixtures/service-bound-container.ts";
import PublishOnlyService from "./fixtures/service-publish-only.ts";
import BoundRedisService from "./fixtures/service-redis.ts";
import SidecarService from "./fixtures/service-sidecar.ts";
import UnboundContainerService from "./fixtures/service-unbound-container.ts";
import BoundService from "./fixtures/service.ts";
import { Static } from "./fixtures/sidecars.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const HELLO_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

const waitUntilGone = (name: string) =>
  cloudrun.getProjectsLocationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a Cloud Run service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Service("Api", {
            location: "us-central1",
            description: "test run service",
            labels: { env: "test" },
            template: {
              containers: [{ image: HELLO_IMAGE }],
            },
          });
        }),
      );

      expect(created.name).toContain("/services/");
      expect(created.serviceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("test run service");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.uri).toEqual(expect.any(String));
      expect(created.terminalConditionState).toEqual("CONDITION_SUCCEEDED");

      const fetched = yield* cloudrun.getProjectsLocationsServices({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("test run service");
      expect(fetched.template?.containers?.[0]?.image).toEqual(HELLO_IMAGE);
      expect(fetched.uri).toEqual(created.uri);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Service("Api", {
            serviceId: created.serviceId,
            location: "us-central1",
            description: "prod run service",
            labels: { env: "prod", role: "api" },
            ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
            template: {
              timeout: "60s",
              containers: [
                {
                  image: HELLO_IMAGE,
                  env: [{ name: "ENV", value: "prod" }],
                },
              ],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("prod run service");
      expect(updated.labels).toMatchObject({ env: "prod", role: "api" });
      expect(updated.ingress).toEqual("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(updated.uri).toEqual(expect.any(String));

      const refetched = yield* cloudrun.getProjectsLocationsServices({
        name: created.name,
      });
      expect(refetched.description).toEqual("prod run service");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("api");
      expect(refetched.ingress).toEqual("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(refetched.template?.timeout).toEqual("60s");
      expect(
        refetched.template?.containers?.[0]?.env?.some(
          (env) => env.name === "ENV" && env.value === "prod",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 120_000 },
);

class ServiceNotReady extends Data.TaggedError("ServiceNotReady")<{
  status: number;
}> {}

const membersOf = (
  policy: {
    bindings?: ReadonlyArray<{
      role?: string;
      members?: ReadonlyArray<string>;
    }>;
  },
  member: string,
) =>
  new Set(
    (policy.bindings ?? [])
      .filter((binding) => (binding.members ?? []).includes(member))
      .map((binding) => binding.role),
  );

const fetchJson = <A>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : Effect.fail(new ServiceNotReady({ status: response.status })),
      ),
      Effect.retry({
        while: (e): e is ServiceNotReady => e._tag === "ServiceNotReady",
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    return (yield* response.json) as A;
  });

const NGINX_IMAGE = "docker.io/library/nginx:1.27-alpine";

const latestRevision = (service: { name: string; latestReadyRevision: string | undefined }) =>
  cloudrun.getProjectsLocationsServicesRevisions({
    name: `${service.name}/revisions/${service.latestReadyRevision?.split("/").pop()}`,
  });

const probedContainers = (
  probe: { periodSeconds: number } | undefined,
): GCP.Run.ContainerSpec[] => [
  {
    name: "proxy",
    image: HELLO_IMAGE,
    ports: [{ name: "http1", containerPort: 8080 }],
    ...(probe ? { dependsOn: ["app"] } : {}),
  },
  {
    name: "app",
    image: NGINX_IMAGE,
    ...(probe
      ? {
          startupProbe: {
            httpGet: { path: "/", port: 80 },
            periodSeconds: probe.periodSeconds,
            failureThreshold: 30,
          },
          livenessProbe: { httpGet: { path: "/", port: 80 }, periodSeconds: 10 },
        }
      : {}),
  },
];

test.provider(
  "startup probes, liveness probes, and dependsOn roll new revisions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (probe: { periodSeconds: number } | undefined) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Run.Service("Probed", {
              location: "us-central1",
              template: { containers: probedContainers(probe) },
            });
          }),
        );

      const created = yield* deploy({ periodSeconds: 2 });
      const first = yield* latestRevision(created);
      const [proxy, app] = first.containers ?? [];
      expect(proxy?.dependsOn).toEqual(["app"]);
      expect(app?.startupProbe).toMatchObject({
        httpGet: { path: "/", port: 80 },
        periodSeconds: 2,
        failureThreshold: 30,
      });
      expect(app?.livenessProbe).toMatchObject({
        httpGet: { path: "/", port: 80 },
        periodSeconds: 10,
      });

      const retimed = yield* deploy({ periodSeconds: 5 });
      expect(retimed.latestReadyRevision).not.toEqual(created.latestReadyRevision);
      const second = yield* latestRevision(retimed);
      expect(second.containers?.[1]?.startupProbe).toMatchObject({
        httpGet: { path: "/", port: 80 },
        periodSeconds: 5,
      });

      // Dropping the probes and dependsOn resets them to Cloud Run's defaults.
      const reset = yield* deploy(undefined);
      expect(reset.latestReadyRevision).not.toEqual(retimed.latestReadyRevision);
      const third = yield* latestRevision(reset);
      expect(third.containers?.[0]?.dependsOn ?? []).toEqual([]);
      expect(third.containers?.[1]?.startupProbe?.httpGet).toBeUndefined();
      expect(third.containers?.[1]?.livenessProbe).toBeUndefined();

      // A redeploy of the reset props is a no-op, not another revision.
      const again = yield* deploy(undefined);
      expect(again.latestReadyRevision).toEqual(reset.latestReadyRevision);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 600_000 },
);

test.provider(
  "an Effect-native service keeps its sidecars and probes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SidecarService;
        }),
      );

      const revision = yield* latestRevision(deployed);
      const [main, sidecar] = revision.containers ?? [];
      expect(revision.containers?.length).toEqual(2);
      expect(main?.dependsOn).toEqual(["sidecar"]);
      expect(main?.startupProbe).toMatchObject({
        httpGet: { path: "/health", port: 8080 },
        periodSeconds: 2,
      });
      expect(sidecar?.name).toEqual("sidecar");
      expect(sidecar?.image).toContain("nginx");

      const client = yield* HttpClient.HttpClient;
      const health = yield* client.get(`${deployed.uri}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new ServiceNotReady({ status: response.status })),
        ),
        Effect.flatMap((response) => response.text),
        Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
      );
      expect(health).toEqual("ok");

      yield* stack.destroy();
      expect(yield* waitUntilGone(deployed.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 900_000 },
);

test.provider(
  "a bound Container runs as a sidecar and answers RPC over localhost",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const { service: deployed, worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { service: yield* BoundContainerService, worker: yield* Worker };
        }),
      );
      expect(worker.repository).toEqual(expect.any(String));

      // Api depends on Worker, which depends on Static: one revision, three containers.
      const revision = yield* latestRevision(deployed);
      const byName = new Map((revision.containers ?? []).map((c) => [c.name ?? "", c]));
      expect(revision.containers?.length).toEqual(3);
      expect(revision.containers?.[0]?.dependsOn).toEqual(["worker"]);
      expect(revision.containers?.[0]?.startupProbe).toMatchObject({
        httpGet: { path: "/health", port: 8080 },
      });
      expect(byName.get("worker")?.dependsOn).toEqual(["static"]);
      expect(byName.get("worker")?.startupProbe).toMatchObject({
        httpGet: { path: "/health", port: 3000 },
      });
      expect(byName.get("static")?.startupProbe).toMatchObject({ tcpSocket: { port: 80 } });

      const client = yield* HttpClient.HttpClient;
      const call = yield* client.get(`${deployed.uri}/call`).pipe(
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (response) => response.status !== 404 && response.status < 502,
          times: 15,
        }),
      );
      expect(call.text).not.toContain("Error");
      expect(call.status).toEqual(200);
      const body = yield* fetchJson<{
        greeting: string;
        counts: number[];
        published: number;
        staticStatus: number;
        health: string;
      }>(`${deployed.uri}/call`);
      expect(body).toEqual({
        greeting: "hello sam",
        counts: [1, 2, 3],
        published: 1,
        staticStatus: 200,
        health: "worker ok",
      });

      // Removing the binding drops the sidecars from the next revision.
      const unbound = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* UnboundContainerService;
        }),
      );
      const solo = yield* latestRevision(unbound);
      expect(solo.containers?.length).toEqual(1);
      expect(solo.containers?.[0]?.dependsOn ?? []).toEqual([]);

      yield* stack.destroy();
      expect(yield* waitUntilGone(deployed.name)).toEqual("gone");
      // The sidecar's image repository went with it.
      const repository = yield* artifactregistry
        .getProjectsLocationsRepositories({
          name: `projects/${project}/locations/us-central1/repositories/${worker.repository}`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(repository).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 900_000 },
);

test.provider(
  "an image-only Service lists a Container in its template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (withWorker: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const worker = yield* Worker;
            const service = yield* GCP.Run.Service("ImageWithContainer", {
              location: "us-central1",
              template: {
                containers: withWorker
                  ? [
                      {
                        image: HELLO_IMAGE,
                        ports: [{ name: "http1", containerPort: 8080 }],
                        dependsOn: [worker.name],
                      },
                      worker,
                    ]
                  : [{ image: HELLO_IMAGE, ports: [{ name: "http1", containerPort: 8080 }] }],
              },
            });
            return { service, topic: (yield* Tweets).name };
          }),
        );

      const { service, topic } = yield* deploy(true);
      // Worker joins the revision, and so does the Static sidecar it binds.
      const revision = yield* latestRevision(service);
      const byName = new Map((revision.containers ?? []).map((c) => [c.name ?? "", c]));
      expect(revision.containers?.length).toEqual(3);
      expect(revision.containers?.[0]?.dependsOn).toEqual(["worker"]);
      expect(byName.get("worker")?.dependsOn).toEqual(["static"]);
      expect(byName.has("static")).toEqual(true);

      // Worker's Pub/Sub binding is granted to the service's account.
      expect(service.managedServiceAccount).toEqual(true);
      const topicPolicy = yield* pubsub.getIamPolicyProjectsTopics({ resource: topic });
      expect([...membersOf(topicPolicy, `serviceAccount:${service.serviceAccount}`)]).toEqual([
        "roles/pubsub.publisher",
      ]);

      // Dropping Worker from the list drops its sidecars too.
      const { service: solo } = yield* deploy(false);
      const soloRevision = yield* latestRevision(solo);
      expect(soloRevision.containers?.length).toEqual(1);

      yield* stack.destroy();
      expect(yield* waitUntilGone(service.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 900_000 },
);

test.provider(
  "a listed Container can depend on another listed Container's name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          const web = yield* Static;
          const cache = yield* GCP.Run.Container("Cache", {
            image: "docker.io/library/redis:7-alpine",
            port: 6379,
            startupProbe: { tcpSocket: {}, periodSeconds: 2, failureThreshold: 30 },
            dependsOn: [web.name],
          });
          return yield* GCP.Run.Service("ListedContainers", {
            location: "us-central1",
            template: {
              containers: [
                {
                  image: HELLO_IMAGE,
                  ports: [{ name: "http1", containerPort: 8080 }],
                  dependsOn: [cache.name],
                },
                cache,
                web,
              ],
            },
          });
        }),
      );

      // The names resolve, so the revision starts static → cache → the ingress.
      const revision = yield* latestRevision(service);
      const byName = new Map((revision.containers ?? []).map((c) => [c.name ?? "", c]));
      expect(revision.containers?.length).toEqual(3);
      expect(revision.containers?.[0]?.dependsOn).toEqual(["cache"]);
      expect(byName.get("cache")?.dependsOn).toEqual(["static"]);
      expect(byName.get("static")?.dependsOn ?? []).toEqual([]);

      yield* stack.destroy();
      expect(yield* waitUntilGone(service.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 900_000 },
);

test.provider(
  "typed Effect RPC and HttpApi clients reach sidecars and private services",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const caller = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EffectApiCaller;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      // A fresh run.invoker grant takes a moment to reach the backends.
      const call = yield* client.get(`${caller.uri}/`).pipe(
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          // Each call reports its own failure in the body.
          until: (response) => response.status === 200 && !response.text.includes('"failed"'),
          times: 24,
        }),
      );
      expect(call.status).toEqual(200);
      expect(JSON.parse(call.text)).toEqual({
        rpcSidecar: { task: "from rpc sidecar", missing: "TaskNotFound", counts: [1, 2, 3] },
        apiSidecar: { task: "from api sidecar", missing: "TaskNotFound" },
        rpcService: { task: "from rpc service", missing: "TaskNotFound", counts: [1, 2, 3] },
        apiService: { task: "from api service", missing: "TaskNotFound" },
      });

      yield* stack.destroy();
      expect(yield* waitUntilGone(caller.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 900_000 },
);

test.provider(
  "effect-native Function grants resource-scoped IAM and revokes it when a binding is removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = (program: typeof BoundService | typeof PublishOnlyService) =>
        stack.deploy(
          Effect.gen(function* () {
            const service = yield* program;
            const topic = yield* Tweets;
            const bucket = yield* DataBucket;
            return {
              uri: service.uri,
              name: service.name,
              project: service.project,
              serviceAccount: service.serviceAccount,
              managedServiceAccount: service.managedServiceAccount,
              topic: topic.name,
              bucket: bucket.bucketName,
            };
          }),
        );

      const out = yield* deployed(BoundService);
      expect(out.managedServiceAccount).toEqual(true);
      expect(out.serviceAccount ?? "").toMatch(/^alch-/);
      const member = `serviceAccount:${out.serviceAccount}`;

      const live = yield* cloudrun.getProjectsLocationsServices({
        name: out.name,
      });
      expect(live.template?.serviceAccount).toEqual(out.serviceAccount);

      // Grants land on the bound resources, never on the project.
      const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
        resource: `projects/${out.project}`,
      });
      expect([...membersOf(projectPolicy, member)]).toEqual([]);
      const topicPolicy = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.topic,
      });
      expect([...membersOf(topicPolicy, member)]).toEqual(["roles/pubsub.publisher"]);
      const bucketPolicy = yield* storage.getIamPolicyBuckets({
        bucket: out.bucket,
      });
      expect([...membersOf(bucketPolicy, member)].sort()).toEqual([
        "roles/storage.objectUser",
        "roles/storage.objectViewer",
      ]);

      // The runtime SA's own token publishes and round-trips object content.
      const body = yield* fetchJson<{ published: boolean; read: string }>(out.uri!);
      expect(body).toEqual({ published: true, read: "stored" });

      // Step 2: drop the Storage bindings. The code change redeploys and the
      // bucket grants are revoked; the topic grant stays.
      const next = yield* deployed(PublishOnlyService);
      expect(next.serviceAccount).toEqual(out.serviceAccount);
      const bucketAfter = yield* storage.getIamPolicyBuckets({
        bucket: out.bucket,
      });
      expect([...membersOf(bucketAfter, member)]).toEqual([]);
      const topicAfter = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.topic,
      });
      expect([...membersOf(topicAfter, member)]).toEqual(["roles/pubsub.publisher"]);
      const step2 = yield* fetchJson<{ published: boolean; step?: number }>(next.uri!).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (response) => response.step === 2,
          times: 15,
        }),
      );
      expect(step2).toEqual({ published: true, step: 2 });

      yield* stack.destroy();

      const saGone = yield* iam
        .getProjectsServiceAccounts({
          name: `projects/${out.project}/serviceAccounts/${out.serviceAccount}`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(saGone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 420_000 },
);

// Memorystore Redis provisioning takes 5-10 minutes.
test.provider.skipIf(!process.env.GCP_TEST_SLOW || !!process.env.FAST)(
  "effect-native Function with Memorystore Redis over Direct VPC",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* BoundRedisService;
          return { uri: service.uri };
        }),
      );

      expect(out.uri).toEqual(expect.any(String));
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(out.uri!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new ServiceNotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (e): e is ServiceNotReady => e._tag === "ServiceNotReady",
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      const body = (yield* res.json) as { redis: string | null };
      expect(body.redis).toEqual("ok");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 1_500_000 },
);

test.provider(
  "a failed first image build removes the repository it created",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const serviceId = `alchemy-test-broken-build-${Core.defaultStage()}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 45)
        .replace(/-+$/, "");
      const location = "us-central1";

      // The per-host repository is created before bundling, so a `main`
      // that cannot be bundled fails after the repository exists.
      const exit = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* GCP.Run.Service("BrokenBuild", {
              serviceId,
              location,
              main: new URL("./fixtures/does-not-exist.ts", import.meta.url).href,
            });
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toEqual(true);

      const repository = yield* artifactregistry
        .getProjectsLocationsRepositories({
          name: `projects/${project}/locations/${location}/repositories/${serviceId}-src`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(repository).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 180_000 },
);
