import * as railway from "@distilled.cloud/railway";
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

const listLive = (
  environmentId: string,
  projectId: string,
  serviceId: string,
) =>
  railway
    .domains(
      { environmentId, projectId, serviceId },
      {
        customDomains: {
          id: true,
          domain: true,
          targetPort: true,
          deletedAt: true,
          syncStatus: true,
        },
      },
    )
    .pipe(
      Effect.map((result) =>
        result.customDomains.filter(
          (domain) =>
            domain.deletedAt == null && domain.syncStatus !== "DELETED",
        ),
      ),
      railway.catchTags(["RailwayNotFound"], () => Effect.succeed([])),
    );

const waitUntilDomainGone = (customDomainId: string, projectId: string) =>
  railway
    .customDomain(
      { id: customDomainId, projectId },
      { deletedAt: true, syncStatus: true },
    )
    .pipe(
      Effect.map((domain) =>
        domain.deletedAt != null || domain.syncStatus === "DELETED"
          ? ("gone" as const)
          : ("found" as const),
      ),
      railway.catchTags(["RailwayNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const createTargetService = (projectId: string, environmentId: string) =>
  railway.createService(
    {
      input: {
        projectId,
        environmentId,
        source: { image: "hashicorp/http-echo" },
      },
    },
    { id: true },
  );

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
        railway.createCustomDomain(
          {
            input: {
              domain: "not a hostname",
              environmentId: environment.environmentId,
              projectId: project.projectId,
              serviceId: service.id,
            },
          },
          { id: true },
        ),
      );
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) {
        expect(
          railway.isErrorTag(rejected.failure, "RailwayValidationError"),
        ).toBe(true);
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

      const outOfBand = yield* railway.customDomain(
        {
          id: created.domain.customDomainId,
          projectId: project.projectId,
        },
        { id: true, domain: true, targetPort: true },
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

      const fetchedUpdate = yield* railway.customDomain(
        {
          id: updated.domain.customDomainId,
          projectId: project.projectId,
        },
        { targetPort: true },
      );
      expect(fetchedUpdate.targetPort).toEqual(8080);

      yield* stack.destroy();

      const domainGone = yield* waitUntilDomainGone(
        created.domain.customDomainId,
        project.projectId,
      );
      expect(domainGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
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

      const fetched = yield* railway.customDomain(
        {
          id: created.domain.customDomainId,
          projectId: project.projectId,
        },
        { domain: true, status: { verified: true } },
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
  { timeout: 120_000 },
);
