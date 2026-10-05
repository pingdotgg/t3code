import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as container from "@distilled.cloud/gcp/container_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Test from "alchemy/Test/Bun";
import { describe, expect } from "bun:test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";
import { seedEntries } from "../src/SeedJob.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(GCP.providers(), Kubernetes.providers()),
  state: Alchemy.localState(),
});

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// `Api` and `SeedJob` are built from `main`, and `Web`'s image is mirrored
// into Artifact Registry — both need a local Docker daemon.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// The project comes from the same credential the deploy uses.
const currentProject = GCP.GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
  Effect.provide(GCP.fromCredentials().pipe(Layer.provide(GcpHttp))),
);

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-gke", () => {
  // Autopilot cluster creation dominates the deploy (~5–10 min).
  const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

  const found = Effect.as("found" as const);
  const gone = () => Effect.succeed("gone" as const);

  /** Poll until a deleted resource reads as gone. */
  const expectGone = <E, R>(
    what: string,
    status: Effect.Effect<"found" | "gone", E, R>,
  ) =>
    status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === "gone",
        times: 12,
      }),
      Effect.tap((status) =>
        Effect.sync(() => expect(`${what}: ${status}`).toBe(`${what}: gone`)),
      ),
    );

  const projectNumber = (project: string) =>
    resourcemanager
      .getProjects({ name: `projects/${project}` })
      .pipe(Effect.map((p) => (p.name ?? "").split("/").pop() ?? ""));

  /** The Workload Identity Federation principal of a Kubernetes ServiceAccount. */
  const ksaPrincipal = (
    project: string,
    number: string,
    namespace: string,
    ksa: string,
  ) =>
    `principal://iam.googleapis.com/projects/${number}/locations/global/` +
    `workloadIdentityPools/${project}.svc.id.goog/subject/ns/${namespace}/sa/${ksa}`;

  /** Project IAM bindings (v3, with conditions) that include `member`. */
  const projectBindingsOf = (member: string) =>
    currentProject.pipe(
      Effect.flatMap((project) =>
        resourcemanager.getIamPolicyProjects({
          resource: `projects/${project}`,
          body: { options: { requestedPolicyVersion: 3 } },
        }),
      ),
      Effect.map((policy) =>
        (policy.bindings ?? []).filter((binding) =>
          (binding.members ?? []).includes(member),
        ),
      ),
    );

  /** Forwarding rules GKE created for Services in the `guestbook` namespace. */
  const guestbookForwardingRules = currentProject.pipe(
    Effect.flatMap((project) =>
      compute.listForwardingRules({ project, region: "us-central1" }),
    ),
    Effect.map((page) =>
      (page.items ?? []).filter((rule) =>
        (rule.description ?? "").includes(
          '"kubernetes.io/service-name":"guestbook/',
        ),
      ),
    ),
  );

  class NotReady extends Data.TaggedError("NotReady")<{ detail: string }> {}

  /**
   * Re-run `attempt` every 10s until it succeeds with a value `ready`
   * accepts. Transport errors count as not ready: a fresh load balancer
   * refuses connections until its backends are healthy.
   */
  const until = <A, E, R>(
    attempt: Effect.Effect<A, E, R>,
    ready: (value: A) => boolean,
    times: number,
  ) =>
    attempt.pipe(
      Effect.filterOrFail(
        ready,
        (value) => new NotReady({ detail: JSON.stringify(value) }),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times }),
    );

  const get = (url: string) =>
    HttpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.map((text) => ({ status: response.status, text })),
        ),
      ),
    );

  /** The principals of the stack's two workloads. */
  const principalsOf = (outputs: {
    namespace: string;
    apiServiceAccount: string;
    seedJobServiceAccount: string;
  }) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      const number = yield* projectNumber(project);
      return [
        ksaPrincipal(
          project,
          number,
          outputs.namespace,
          outputs.apiServiceAccount,
        ),
        ksaPrincipal(
          project,
          number,
          outputs.namespace,
          outputs.seedJobServiceAccount,
        ),
      ];
    }).pipe(Effect.provide(GcpHttp));

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const outputs = yield* stack;
      const principals =
        outputs === undefined ? [] : yield* principalsOf(outputs);
      yield* destroy(Stack);
      if (outputs === undefined) return;

      // Every grant is revoked from the workloads' principals.
      for (const principal of principals) {
        const bindings = yield* projectBindingsOf(principal).pipe(
          Effect.provide(GcpHttp),
        );
        expect(bindings).toEqual([]);
      }
      // The LoadBalancer Services were drained before the cluster went, so
      // no load balancer leaked.
      expect(
        yield* guestbookForwardingRules.pipe(Effect.provide(GcpHttp)),
      ).toEqual([]);
      yield* expectGone(
        "cluster",
        container
          .getProjectsLocationsClusters({ name: outputs.clusterName })
          .pipe(
            found,
            Effect.catchTag("NotFound", gone),
            Effect.provide(GcpHttp),
          ),
      );
      yield* expectGone(
        "database",
        firestore
          .getProjectsDatabases({ name: outputs.databaseName })
          .pipe(
            found,
            Effect.catchTag("NotFound", gone),
            Effect.provide(GcpHttp),
          ),
      );
    }),
    { timeout: 1_800_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  interface Entry {
    id: string;
    author: string;
    message: string;
  }

  test(
    "grants each binding to its Kubernetes ServiceAccount principal",
    Effect.gen(function* () {
      const outputs = yield* stack;
      for (const principal of yield* principalsOf(outputs)) {
        const bindings = yield* projectBindingsOf(principal).pipe(
          Effect.provide(GcpHttp),
        );
        // `roles/datastore.user` on the project, conditioned to the
        // guestbook database only.
        expect(bindings).toHaveLength(1);
        expect(bindings[0]!.role).toEqual("roles/datastore.user");
        expect(bindings[0]!.condition?.expression).toContain(
          `resource.name == "${outputs.databaseName}"`,
        );
      }
    }),
    { timeout: 120_000 },
  );

  test(
    "the SeedJob seeded the guestbook through Workload Identity",
    Effect.gen(function* () {
      const { apiUrl } = yield* stack;
      const baseUrl = baseUrlOf(apiUrl);
      expect(baseUrl).toMatch(/^http:\/\/[^/]+:3000$/);

      // Autopilot provisions nodes for the Job's pod on demand, and a fresh
      // Firestore grant takes a few minutes to propagate; the Job retries
      // with backoff meanwhile.
      const listed = yield* until(
        get(`${baseUrl}/entries`).pipe(
          Effect.map((response) =>
            response.status === 200
              ? (JSON.parse(response.text) as { entries: Entry[] })
              : { entries: [] as Entry[] },
          ),
        ),
        (body) =>
          seedEntries.every((seed) =>
            body.entries.some((entry) => entry.id === seed.id),
          ),
        60,
      );
      for (const seed of seedEntries) {
        expect(listed.entries).toContainEqual({
          id: seed.id,
          author: seed.id,
          message: seed.message,
        });
      }

      const ada = yield* get(`${baseUrl}/entries/ada`);
      expect(ada.status).toBe(200);
      expect(JSON.parse(ada.text)).toMatchObject({ id: "ada", author: "ada" });
    }),
    { timeout: 720_000 },
  );

  test(
    "signs the guestbook and reads the entry back",
    Effect.gen(function* () {
      const { apiUrl, databaseName } = yield* stack;
      const baseUrl = baseUrlOf(apiUrl);

      // Until the Firestore grant has propagated the API answers 500.
      const created = yield* until(
        HttpClient.execute(
          HttpClientRequest.post(
            `${baseUrl}/entries?author=integ&message=hello%20from%20gke`,
          ),
        ).pipe(
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.map((text) => ({ status: response.status, text })),
            ),
          ),
        ),
        (response) => response.status !== 500,
        42,
      );
      expect(created.status).toBe(200);
      const entry = JSON.parse(created.text) as Entry;
      expect(entry).toMatchObject({
        author: "integ",
        message: "hello from gke",
      });

      const read = yield* get(`${baseUrl}/entries/${entry.id}`);
      expect(read.status).toBe(200);
      expect(JSON.parse(read.text)).toEqual(entry);

      // The write is a real Firestore document.
      const document = yield* firestore
        .getProjectsDatabasesDocuments({
          name: `${databaseName}/documents/entries/${entry.id}`,
        })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(document.fields?.message?.stringValue).toEqual("hello from gke");

      const missing = yield* get(`${baseUrl}/entries/nope-nope`);
      expect(missing.status).toBe(404);
    }),
    { timeout: 600_000 },
  );

  test(
    "serves the external nginx Web deployment",
    Effect.gen(function* () {
      const { webUrl } = yield* stack;
      const baseUrl = baseUrlOf(webUrl);
      expect(baseUrl).toMatch(/^http:\/\/[^/:]+$/);
      const res = yield* until(get(`${baseUrl}/`), (r) => r.status === 200, 24);
      expect(res.text).toContain("nginx");
    }),
    { timeout: 300_000 },
  );
});
