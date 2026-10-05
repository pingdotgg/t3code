import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { projectServices } from "@/Railway/GraphQL.ts";
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

const PUBLIC_TEMPLATE_CODE = "postgres";

const readServiceDeletedAt = Query.fn((id: string) => ({
  deletedAt: RailwayApi.service({ id }).deletedAt,
}));

const readServiceTemplateId = Query.fn((id: string) => ({
  templateId: RailwayApi.service({ id }).templateId,
}));

const readTemplateByCode = Query.fn((code: string) => {
  const template = RailwayApi.template({ code });
  return {
    id: template.id,
    code: template.code,
    name: template.name,
    serializedConfig: template.serializedConfig,
  };
});

const readTemplateById = Query.fn((id: string) => {
  const template = RailwayApi.template({ id });
  return { id: template.id, code: template.code };
});

const readTemplateSourceForProject = Query.fn((projectId: string) =>
  RailwayApi.templateSourceForProject({ projectId }).pipe(
    Query.map((template) => ({ id: template.id })),
  ),
);

const waitUntilServiceGone = (serviceId: string) =>
  readServiceDeletedAt(serviceId).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "lookup a well-known public template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fetched = yield* readTemplateByCode(PUBLIC_TEMPLATE_CODE);
      expect(fetched.id).toEqual(expect.any(String));
      expect(fetched.id.length).toBeGreaterThan(0);
      expect(fetched.code).toEqual(PUBLIC_TEMPLATE_CODE);
      expect(fetched.name).toEqual(expect.any(String));
      expect(fetched.serializedConfig).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:railway", "provider:railway:template", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "deploy, list, and delete a marketplace template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const deployed = yield* Railway.Template("Postgres", {
            templateId: PUBLIC_TEMPLATE_CODE,
            project,
            environment,
          });
          return { project, environment, deployed };
        }),
      );

      expect(created.deployed.templateId).toEqual(expect.any(String));
      expect(created.deployed.templateId.length).toBeGreaterThan(0);
      expect(created.deployed.code).toEqual(PUBLIC_TEMPLATE_CODE);
      expect(created.deployed.name).toEqual(expect.any(String));
      expect(created.deployed.projectId).toEqual(created.project.projectId);
      expect(created.deployed.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.deployed.workspaceId).toEqual(created.project.workspaceId);
      expect(created.deployed.ownsProject).toEqual(false);
      expect(created.deployed.serviceIds.length).toBeGreaterThan(0);
      expect(created.deployed.url).toEqual(
        `https://railway.com/project/${created.project.projectId}`,
      );

      const live = yield* projectServices(
        created.project.projectId,
        (service) => ({ id: service.id, deletedAt: service.deletedAt }),
      );
      const liveIds = live
        .filter((node) => node.deletedAt == null)
        .map((node) => node.id);
      for (const serviceId of created.deployed.serviceIds) {
        expect(liveIds).toContain(serviceId);
      }

      const source = yield* readTemplateSourceForProject(
        created.project.projectId,
      ).pipe(
        Effect.catchTag("RailwayForbidden", () => Effect.succeed(undefined)),
      );
      if (source != null) {
        expect(source.id).toEqual(created.deployed.templateId);
      }

      const stamped = yield* readServiceTemplateId(
        created.deployed.serviceIds[0]!,
      );
      if (stamped.templateId != null) {
        expect(stamped.templateId).toEqual(created.deployed.templateId);
      }

      const provider = yield* Provider.findProvider(Railway.Template);
      const listed = yield* provider.list();
      const found = listed.find(
        (row) =>
          row.projectId === created.deployed.projectId &&
          row.templateId === created.deployed.templateId,
      );
      expect(found).toBeDefined();
      if (found === undefined) {
        return yield* Effect.fail(
          new Error("Deployed marketplace template was not listed"),
        );
      }
      expect(found.templateId).toEqual(created.deployed.templateId);
      expect(found.serviceIds.length).toBeGreaterThan(0);
      if (found.code !== undefined) {
        expect(found.code).toEqual(PUBLIC_TEMPLATE_CODE);
      } else {
        // Listing preserves service ownership even when Railway refuses
        // marketplace metadata by ID. Confirm that omission against the API.
        const metadata = yield* Effect.result(
          readTemplateById(found.templateId),
        );
        expect(Result.isFailure(metadata)).toBe(true);
        if (Result.isFailure(metadata)) {
          expect(
            ["RailwayForbidden", "RailwayNotFound"].includes(
              metadata.failure._tag,
            ),
          ).toBe(true);
        }
      }

      yield* stack.destroy();

      for (const serviceId of created.deployed.serviceIds) {
        const gone = yield* waitUntilServiceGone(serviceId);
        expect(gone).toEqual("gone");
      }
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:template",
      "live",
    ],
    timeout: 120_000,
  },
);
