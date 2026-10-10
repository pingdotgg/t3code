import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// The project comes from the same credential the deploy uses.
const currentProject = GCP.GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
  Effect.provide(GCP.fromCredentials().pipe(Layer.provide(GcpHttp))),
);

// The service is built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-vertex-ai", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

  const serviceState = (name: string) =>
    cloudrun.getProjectsLocationsServices({ name }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.orDie,
      Effect.provide(GcpHttp),
    );

  /** Members holding `roles/aiplatform.user` on the project. */
  const aiplatformUsers = currentProject.pipe(
    Effect.flatMap((project) =>
      resourcemanager.getIamPolicyProjects({
        resource: `projects/${project}`,
        body: { options: { requestedPolicyVersion: 3 } },
      }),
    ),
    Effect.map((policy) =>
      (policy.bindings ?? [])
        .filter((binding) => binding.role === "roles/aiplatform.user")
        .flatMap((binding) => binding.members ?? []),
    ),
    Effect.orDie,
    Effect.provide(GcpHttp),
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { serviceName, serviceAccount } = yield* stack;
      yield* destroy(Stack);
      // Nothing is left behind: the service is gone and its grant revoked.
      expect(yield* serviceState(serviceName)).toEqual("gone");
      expect(yield* aiplatformUsers).not.toContain(
        `serviceAccount:${serviceAccount}`,
      );
    }),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  const chat = (baseUrl: string, body: Record<string, unknown>) =>
    HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/chat`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );

  test(
    "grants the runtime service account roles/aiplatform.user",
    Effect.gen(function* () {
      const { serviceAccount } = yield* stack;
      expect(yield* aiplatformUsers).toContain(
        `serviceAccount:${serviceAccount}`,
      );
    }),
    { timeout: 60_000 },
  );

  test(
    "POST /chat answers with Gemini",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      // A fresh project-level grant can take a minute or two to reach
      // Vertex AI; until then the service answers 500 (Forbidden).
      const res = yield* chat(baseUrl, {
        prompt: "Reply with exactly: pong",
        temperature: 0,
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (response) => response.status !== 500,
          times: 30,
        }),
      );
      expect(res.status).toBe(200);
      const body = (yield* res.json) as {
        text: string;
        modelVersion: string;
        usage: { inputTokens: number };
      };
      expect(body.text.length).toBeGreaterThan(0);
      expect(body.text.toLowerCase()).toContain("pong");
      expect(body.modelVersion).toContain("gemini-2.5-flash");
      expect(body.usage.inputTokens).toBeGreaterThan(0);
    }),
    { timeout: 420_000 },
  );

  test(
    "POST /chat rejects a missing prompt",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);
      const res = yield* chat(baseUrl, {});
      expect(res.status).toBe(400);
    }),
    { timeout: 120_000 },
  );
});
