import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const PUBLIC_TEMPLATE_CODE = "postgres";

const waitUntilServiceGone = (serviceId: string) =>
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
  "lookup a well-known public template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fetched = yield* railway.template({ code: PUBLIC_TEMPLATE_CODE });
      expect(fetched.id).toEqual(expect.any(String));
      expect(fetched.id.length).toBeGreaterThan(0);
      expect(fetched.code).toEqual(PUBLIC_TEMPLATE_CODE);
      expect(fetched.name).toEqual(expect.any(String));
      expect(fetched.serializedConfig).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test.provider.skip(
  "deploy, list, and delete a marketplace template (service still found after destroy)",
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

      const live = yield* railway.project({ id: created.project.projectId });
      const liveIds = live.services.edges
        .map((edge) => edge.node)
        .filter((node) => node.deletedAt == null)
        .map((node) => node.id);
      for (const serviceId of created.deployed.serviceIds) {
        expect(liveIds).toContain(serviceId);
      }

      const source = yield* railway
        .templateSourceForProject({
          projectId: created.project.projectId,
        })
        .pipe(
          Effect.catchTag(
            ["RailwayNotFound", "NotFound", "RailwayForbidden"],
            () => Effect.succeed(undefined),
          ),
        );
      if (source !== undefined) {
        expect(source.id).toEqual(created.deployed.templateId);
      }

      const stamped = yield* railway.service({
        id: created.deployed.serviceIds[0]!,
      });
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
      expect(found?.code).toEqual(PUBLIC_TEMPLATE_CODE);
      expect(found?.serviceIds.length).toBeGreaterThan(0);

      yield* stack.destroy();

      for (const serviceId of created.deployed.serviceIds) {
        const gone = yield* waitUntilServiceGone(serviceId);
        expect(gone).toEqual("gone");
      }
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
