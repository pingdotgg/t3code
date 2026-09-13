import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { withEnvironmentConfigLock } from "@/Railway/transient.ts";
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

const waitUntilNoServiceDomains = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
}) =>
  railway.domains(input).pipe(
    Effect.map((domains) =>
      domains.serviceDomains.some(
        (domain) =>
          domain.deletedAt == null &&
          domain.syncStatus !== "DELETED" &&
          domain.syncStatus !== "DELETING",
      )
        ? ("found" as const)
        : ("gone" as const),
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
            image: "nginx:alpine",
            port: 80,
            healthcheckPath: "/",
            preDeploy: { command: "echo predeploy" },
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
      expect(created.api.port).toEqual(80);
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
        expect.stringContaining("nginx:alpine"),
      );
      expect(instance.healthcheckPath).toEqual("/");
      expect(
        instance.preDeployCommand === "echo predeploy" ||
          (Array.isArray(instance.preDeployCommand) &&
            instance.preDeployCommand.length === 1 &&
            instance.preDeployCommand[0] === "echo predeploy"),
      ).toEqual(true);
      // Railway omits numReplicas until you scale; default is one replica.
      expect(
        instance.numReplicas === null || instance.numReplicas === 1,
      ).toEqual(true);
      expect(created.api.healthcheckPath).toEqual("/");
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
      expect(liveDomain?.targetPort).toEqual(80);

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
            image: "nginx:alpine",
            port: 80,
            name: nextName,
            healthcheckPath: "/",
            preDeploy: { command: null },
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
      expect(updatedInstance.healthcheckPath).toEqual("/");
      expect(
        updatedInstance.preDeployCommand == null ||
          (Array.isArray(updatedInstance.preDeployCommand) &&
            updatedInstance.preDeployCommand.length === 0),
      ).toEqual(true);

      const fetchedUpdate = yield* railway.service({
        id: updated.api.serviceId,
      });
      expect(fetchedUpdate.id).toEqual(updated.api.serviceId);
      expect(fetchedUpdate.name).toEqual(nextName);

      const privateUpdate = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            name: nextName,
            healthcheckPath: "/health",
            publicDomain: false,
          });
          return { api };
        }),
      );

      expect(privateUpdate.api.serviceId).toEqual(created.api.serviceId);
      expect(privateUpdate.api.dnsName).toEqual(`${nextName}.railway.internal`);
      expect(privateUpdate.api.url).toBeUndefined();
      expect(privateUpdate.api.domain).toBeUndefined();
      expect(privateUpdate.api.domainId).toBeUndefined();
      expect(
        yield* waitUntilNoServiceDomains({
          projectId: privateUpdate.api.projectId,
          environmentId: privateUpdate.api.environmentId,
          serviceId: privateUpdate.api.serviceId,
        }),
      ).toEqual("gone");

      const publicUpdate = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            name: nextName,
            healthcheckPath: "/health",
            publicDomain: true,
          });
          return { api };
        }),
      );

      expect(publicUpdate.api.serviceId).toEqual(created.api.serviceId);
      expect(publicUpdate.api.domainId).toEqual(expect.any(String));
      expect(publicUpdate.api.url).toEqual(
        `https://${publicUpdate.api.domain}`,
      );
      expect(publicUpdate.api.dnsName).toEqual(`${nextName}.railway.internal`);

      // Add a foreign generated domain. The config map key may not equal
      // the GraphQL id, and list order is not ownership — wait for a new
      // live row rather than assuming `[0] === patch UUID`.
      const liveDomainIds = (domains: {
        serviceDomains: ReadonlyArray<{
          id: string;
          deletedAt: string | null;
          syncStatus: string;
        }>;
      }) =>
        domains.serviceDomains
          .filter(
            (domain) =>
              domain.deletedAt == null &&
              domain.syncStatus !== "DELETED" &&
              domain.syncStatus !== "DELETING",
          )
          .map((domain) => domain.id);
      const beforeForeign = new Set(
        liveDomainIds(
          yield* railway.domains({
            projectId: publicUpdate.api.projectId,
            environmentId: publicUpdate.api.environmentId,
            serviceId: publicUpdate.api.serviceId,
          }),
        ),
      );
      const foreignPatchId = yield* Effect.sync(() => crypto.randomUUID());
      yield* withEnvironmentConfigLock(
        publicUpdate.api.environmentId,
        railway.environmentPatchCommit({
          environmentId: publicUpdate.api.environmentId,
          commitMessage: "Arrange generated domains for ownership test",
          patch: {
            services: {
              [publicUpdate.api.serviceId]: {
                networking: {
                  serviceDomains: {
                    [foreignPatchId]: {},
                    [publicUpdate.api.domainId!]: {},
                  },
                },
              },
            },
          },
        }),
      );
      const orderedIds = yield* railway
        .domains({
          projectId: publicUpdate.api.projectId,
          environmentId: publicUpdate.api.environmentId,
          serviceId: publicUpdate.api.serviceId,
        })
        .pipe(
          Effect.map(liveDomainIds),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (ids) =>
              ids.includes(publicUpdate.api.domainId!) &&
              (ids.includes(foreignPatchId) ||
                ids.some((id) => !beforeForeign.has(id))),
            times: 15,
          }),
        );
      const foreignDomainId =
        orderedIds.find((id) => id === foreignPatchId) ??
        orderedIds.find((id) => !beforeForeign.has(id));
      expect(foreignDomainId).toBeDefined();
      if (foreignDomainId === undefined) {
        return;
      }
      expect(foreignDomainId).not.toEqual(publicUpdate.api.domainId);
      expect(orderedIds).toContain(publicUpdate.api.domainId);

      const publicWithForeignDomain = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            name: nextName,
            healthcheckPath: "/health",
            publicDomain: true,
          });
          return { api };
        }),
      );
      expect(publicWithForeignDomain.api.domainId).toEqual(
        publicUpdate.api.domainId,
      );

      const privateWithForeignDomain = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            name: nextName,
            healthcheckPath: "/health",
            publicDomain: false,
          });
          return { api };
        }),
      );
      expect(privateWithForeignDomain.api.domainId).toBeUndefined();
      const remainingDomains = yield* railway.domains({
        projectId: publicUpdate.api.projectId,
        environmentId: publicUpdate.api.environmentId,
        serviceId: publicUpdate.api.serviceId,
      });
      const remainingIds = remainingDomains.serviceDomains
        .filter(
          (domain) =>
            domain.deletedAt == null && domain.syncStatus !== "DELETED",
        )
        .map((domain) => domain.id);
      expect(remainingIds).toContain(foreignDomainId);
      expect(remainingIds).not.toContain(publicUpdate.api.domainId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.api.serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test.provider(
  "create, read, and delete a private image service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const worker = yield* Railway.Service("Worker", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            publicDomain: false,
          });
          return { worker };
        }),
      );

      expect(created.worker.serviceId).toEqual(expect.any(String));
      expect(created.worker.dnsName).toEqual(
        `${created.worker.name}.railway.internal`,
      );
      expect(created.worker.url).toBeUndefined();
      expect(created.worker.domain).toBeUndefined();
      expect(created.worker.domainId).toBeUndefined();
      expect(
        yield* waitUntilNoServiceDomains({
          projectId: created.worker.projectId,
          environmentId: created.worker.environmentId,
          serviceId: created.worker.serviceId,
        }),
      ).toEqual("gone");

      // A second deploy exercises refresh/read without claiming or creating a
      // generated domain.
      const refreshed = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const worker = yield* Railway.Service("Worker", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
            publicDomain: false,
          });
          return { worker };
        }),
      );
      expect(refreshed.worker.serviceId).toEqual(created.worker.serviceId);
      expect(refreshed.worker.dnsName).toEqual(created.worker.dnsName);
      expect(refreshed.worker.url).toBeUndefined();
      expect(refreshed.worker.domain).toBeUndefined();
      expect(refreshed.worker.domainId).toBeUndefined();

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.worker.serviceId)).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

const localContextDir = `${import.meta.dirname}/fixtures/local-context`;

test.provider(
  "create, serve, switch to image, and delete a local Docker context service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Ctx", {
            project,
            environment,
            context: localContextDir,
            port: 80,
            healthcheckPath: "/",
          });
          return { api };
        }),
      );

      expect(created.api.serviceId).toEqual(expect.any(String));
      expect(created.api.domain).toContain("up.railway.app");
      expect(created.api.url).toEqual(`https://${created.api.domain}`);

      const fromContext = yield* railway.serviceInstance({
        environmentId: created.api.environmentId,
        serviceId: created.api.serviceId,
      });
      expect(fromContext.dockerfilePath).toEqual("Dockerfile");

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(created.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 20,
        }),
      );
      expect(typeof body).toEqual("string");
      expect(body.length).toBeGreaterThan(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Ctx", {
            project,
            environment,
            image: "nginx:alpine",
            port: 80,
            healthcheckPath: "/",
          });
          return { api };
        }),
      );
      expect(updated.api.serviceId).toEqual(created.api.serviceId);

      const fromImage = yield* railway.serviceInstance({
        environmentId: updated.api.environmentId,
        serviceId: updated.api.serviceId,
      });
      expect(fromImage.source?.image).toEqual(
        expect.stringContaining("nginx:alpine"),
      );

      const afterImage = yield* client.get(updated.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 20,
        }),
      );
      expect(typeof afterImage).toEqual("string");
      expect(afterImage.length).toBeGreaterThan(0);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.api.serviceId)).toEqual("gone");
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
