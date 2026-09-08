import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, serve, list, update, and delete an image service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            healthcheckPath: "/health",
          });
          return { project, environment, api };
        }),
      );

      expect(created.api.serviceId).toEqual(expect.any(String));
      expect(created.api.serviceId.length).toBeGreaterThan(0);
      expect(created.api.projectId).toEqual(created.project.projectId);
      expect(created.api.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.api.name).toEqual(expect.any(String));
      expect(created.api.name.length).toBeGreaterThan(0);
      expect(created.api.name.length).toBeLessThanOrEqual(32);
      expect(created.api.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.api.port).toEqual(5678);
      expect(created.api.domain).toEqual(expect.any(String));
      expect(created.api.domain).toContain("up.railway.app");
      expect(created.api.url).toEqual(`https://${created.api.domain}`);
      expect(created.api.domainId).toEqual(expect.any(String));
      expect(created.api.domainId!.length).toBeGreaterThan(0);

      const fetched = yield* railway.service({ id: created.api.serviceId });
      expect(fetched.id).toEqual(created.api.serviceId);
      expect(fetched.name).toEqual(created.api.name);
      expect(fetched.projectId).toEqual(created.api.projectId);
      expect(fetched.deletedAt).toBeNull();

      const instance = yield* railway.serviceInstance({
        environmentId: created.api.environmentId,
        serviceId: created.api.serviceId,
      });
      expect(instance.serviceId).toEqual(created.api.serviceId);
      expect(instance.environmentId).toEqual(created.api.environmentId);
      expect(instance.source?.image).toEqual(
        expect.stringContaining("hashicorp/http-echo"),
      );
      expect(instance.healthcheckPath).toEqual("/health");
      // Railway omits numReplicas until you scale; default is one replica.
      expect(
        instance.numReplicas === null || instance.numReplicas === 1,
      ).toEqual(true);
      expect(created.api.healthcheckPath).toEqual("/health");
      expect(
        created.api.replicas === undefined || created.api.replicas === 1,
      ).toEqual(true);

      const domains = yield* railway.domains({
        environmentId: created.api.environmentId,
        projectId: created.api.projectId,
        serviceId: created.api.serviceId,
      });
      const liveDomain = domains.serviceDomains.find(
        (domain) => domain.deletedAt == null && domain.syncStatus !== "DELETED",
      );
      expect(liveDomain).toBeDefined();
      expect(liveDomain?.domain).toEqual(created.api.domain);
      expect(liveDomain?.targetPort).toEqual(5678);

      const provider = yield* Provider.findProvider(Railway.Service);
      const listed = yield* provider.list();
      const found = listed.find(
        (service) => service.serviceId === created.api.serviceId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.api.name);
      expect(found?.projectId).toEqual(created.api.projectId);

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(created.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
      );
      expect(typeof body).toEqual("string");
      expect(body.length).toBeGreaterThan(0);

      const nextName =
        created.api.name.slice(0, -1) +
        (created.api.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            name: nextName,
            healthcheckPath: "/health",
          });
          return { project, environment, api };
        }),
      );

      expect(updated.api.serviceId).toEqual(created.api.serviceId);
      expect(updated.api.name).toEqual(nextName);
      expect(updated.api.projectId).toEqual(created.api.projectId);
      expect(updated.api.url).toEqual(created.api.url);

      const updatedInstance = yield* railway.serviceInstance({
        environmentId: updated.api.environmentId,
        serviceId: updated.api.serviceId,
      });
      expect(updatedInstance.healthcheckPath).toEqual("/health");

      const fetchedUpdate = yield* railway.service({
        id: updated.api.serviceId,
      });
      expect(fetchedUpdate.id).toEqual(updated.api.serviceId);
      expect(fetchedUpdate.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.api.serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

// GitHub repo source requires a GitHub App connection on the Railway
// account. The probe always runs and pins the typed gate tag. The
// lifecycle is opt-in via RAILWAY_TEST_GITHUB=1.
const githubEntitled = !!process.env.RAILWAY_TEST_GITHUB;

test.provider(
  "unconnected GitHub surfaces a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* Effect.result(railway.githubRepos({}));
      if (Result.isSuccess(result)) {
        yield* Effect.logInfo(
          `GitHub is connected (${result.success.length} repos); probe is a no-op`,
        );
        yield* stack.destroy();
        return;
      }

      // GitHub App is not connected for this token: GraphQL `Not Authorized`
      // is already the typed `RailwayForbidden` tag (never UnknownRailwayError).
      expect(result.failure._tag).toEqual("RailwayForbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test.provider.skipIf(!githubEntitled)(
  "create a github repo service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repos = yield* railway.githubRepos({});
      const repo = repos[0];
      expect(repo).toBeDefined();
      expect(repo!.fullName.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            repo: repo!.fullName,
            branch: repo!.defaultBranch,
          });
          return { project, environment, api };
        }),
      );

      expect(created.api.serviceId).toEqual(expect.any(String));
      expect(created.api.repo).toEqual(repo!.fullName);

      const instance = yield* railway.serviceInstance({
        environmentId: created.api.environmentId,
        serviceId: created.api.serviceId,
      });
      expect(instance.source?.repo).toEqual(repo!.fullName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.api.serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
