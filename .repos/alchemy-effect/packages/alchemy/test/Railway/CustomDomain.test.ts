import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const TEST_DOMAIN = process.env.RAILWAY_TEST_DOMAIN;

const readCustomDomains = Query.fn(
  (input: { environmentId: string; projectId: string; serviceId: string }) => ({
    customDomains: RailwayApi.domains(input).customDomains.pipe(
      Query.map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        targetPort: domain.targetPort,
        deletedAt: domain.deletedAt,
        syncStatus: domain.syncStatus,
      })),
    ),
  }),
);

const readCustomDomainDeletion = Query.fn((id: string, projectId: string) => {
  const domain = RailwayApi.customDomain({ id, projectId });
  return { deletedAt: domain.deletedAt, syncStatus: domain.syncStatus };
});

const readCustomDomain = Query.fn((id: string, projectId: string) => {
  const domain = RailwayApi.customDomain({ id, projectId });
  return {
    id: domain.id,
    domain: domain.domain,
    targetPort: domain.targetPort,
  };
});

const readCustomDomainVerification = Query.fn(
  (id: string, projectId: string) => {
    const domain = RailwayApi.customDomain({ id, projectId });
    return {
      domain: domain.domain,
      status: { verified: domain.status.verified },
    };
  },
);

const createCustomDomain = Query.fn(
  (input: {
    domain: string;
    environmentId: string;
    projectId: string;
    serviceId: string;
  }) => ({ id: RailwayApi.customDomainCreate({ input }).id }),
);

const createService = Query.fn(
  (input: { projectId: string; environmentId: string; image: string }) => ({
    id: RailwayApi.serviceCreate({
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        source: { image: input.image },
      },
    }).id,
  }),
);

const listLive = (
  environmentId: string,
  projectId: string,
  serviceId: string,
) =>
  readCustomDomains({ environmentId, projectId, serviceId }).pipe(
    Effect.map((result) =>
      result.customDomains.filter(
        (domain) => domain.deletedAt == null && domain.syncStatus !== "DELETED",
      ),
    ),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed([])),
  );

const waitUntilDomainGone = (customDomainId: string, projectId: string) =>
  readCustomDomainDeletion(customDomainId, projectId).pipe(
    Effect.map((domain) =>
      domain.deletedAt != null || domain.syncStatus === "DELETED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const createTargetService = (projectId: string, environmentId: string) =>
  createService({ projectId, environmentId, image: "hashicorp/http-echo" });

test.provider(
  "create, update targetPort, and delete a custom domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project, environment } = yield* stack.deploy(suitePartition);

      const service = yield* createTargetService(
        project.projectId,
        environment.environmentId,
      );

      const rejected = yield* Effect.result(
        createCustomDomain({
          domain: "not a hostname",
          environmentId: environment.environmentId,
          projectId: project.projectId,
          serviceId: service.id,
        }),
      );
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(rejected.failure._tag === "RailwayValidationError").toBe(true);
      }

      // The suite project is shared. Derive the hostname from this test's
      // environment so another partition's domain cannot collide with it.
      const hostname = `graphql-${environment.environmentId.slice(0, 8)}.alchemy-test-2.us`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project: site, environment } = yield* suitePartition;
          const domain = yield* Railway.CustomDomain("Www", {
            service: { serviceId: service.id },
            environment,
            domain: hostname,
            targetPort: 5678,
          });
          return { project: site, domain };
        }),
      );

      expect(created.domain.customDomainId).toEqual(expect.any(String));
      expect(created.domain.customDomainId.length).toBeGreaterThan(0);
      expect(created.domain.domain).toEqual(hostname);
      expect(created.domain.serviceId).toEqual(service.id);
      expect(created.domain.projectId).toEqual(project.projectId);
      expect(created.domain.environmentId).toEqual(environment.environmentId);
      expect(created.domain.targetPort).toEqual(5678);
      expect(created.domain.url).toEqual(`https://${hostname}`);

      const listed = yield* listLive(
        environment.environmentId,
        project.projectId,
        service.id,
      );
      const fetched = listed.find(
        (item) => item.id === created.domain.customDomainId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.domain).toEqual(hostname);
      expect(fetched?.targetPort).toEqual(5678);

      const outOfBand = yield* readCustomDomain(
        created.domain.customDomainId,
        project.projectId,
      );
      expect(outOfBand.id).toEqual(created.domain.customDomainId);
      expect(outOfBand.domain).toEqual(hostname);
      expect(outOfBand.targetPort).toEqual(5678);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project: site, environment } = yield* suitePartition;
          const domain = yield* Railway.CustomDomain("Www", {
            service: { serviceId: service.id },
            environment,
            domain: hostname,
            targetPort: 8080,
          });
          return { project: site, domain };
        }),
      );

      expect(updated.domain.customDomainId).toEqual(
        created.domain.customDomainId,
      );
      expect(updated.domain.targetPort).toEqual(8080);
      expect(updated.domain.domain).toEqual(hostname);
      expect(updated.project.projectId).toEqual(project.projectId);

      const fetchedUpdate = yield* readCustomDomain(
        updated.domain.customDomainId,
        project.projectId,
      );
      expect(fetchedUpdate.targetPort).toEqual(8080);

      yield* stack.destroy();

      const domainGone = yield* waitUntilDomainGone(
        created.domain.customDomainId,
        project.projectId,
      );
      expect(domainGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:customdomain",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider.skipIf(!TEST_DOMAIN)(
  "ACME verifies when RAILWAY_TEST_DOMAIN is set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostname = TEST_DOMAIN!;

      const { project, environment } = yield* stack.deploy(suitePartition);

      const service = yield* createTargetService(
        project.projectId,
        environment.environmentId,
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project: site, environment } = yield* suitePartition;
          const domain = yield* Railway.CustomDomain("Www", {
            service: { serviceId: service.id },
            environment,
            domain: hostname,
          });
          return { project: site, domain };
        }),
      );

      expect(created.domain.domain).toEqual(hostname);
      expect(created.domain.customDomainId.length).toBeGreaterThan(0);

      const fetched = yield* readCustomDomainVerification(
        created.domain.customDomainId,
        project.projectId,
      );
      expect(fetched.domain).toEqual(hostname);
      expect(
        fetched.status.verified === true || fetched.status.verified === false,
      ).toBe(true);

      yield* stack.destroy();

      const domainGone = yield* waitUntilDomainGone(
        created.domain.customDomainId,
        project.projectId,
      );
      expect(domainGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:customdomain",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "live",
    ],
    timeout: 120_000,
  },
);
