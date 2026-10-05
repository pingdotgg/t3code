import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as servicemanagement from "@distilled.cloud/gcp/servicemanagement_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const missingNameOf = (project: string) =>
  `alch-missing.endpoints.${project}.cloud.goog`;

const waitUntilGone = (serviceName: string) =>
  servicemanagement.getServices({ serviceName }).pipe(
    Effect.as("found" as const),
    // Service Management answers a missing service with 403 "not found or
    // permission denied", typed ServiceNotFound.
    Effect.catchTag(["NotFound", "ServiceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getServices on a missing service fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingName = missingNameOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        servicemanagement.getServices({ serviceName: missingName }),
      );
      expect(error._tag).toEqual("ServiceNotFound");

      const page = yield* servicemanagement.listServices({
        producerProjectId: project,
        pageSize: 10,
      });
      expect(
        (page.services ?? []).map((service) => service.serviceName),
      ).not.toContain(missingName);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:servicemanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a managed service",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ServiceManagement.Service("Hello", {
            title: "Alchemy SM",
          });
        }),
      );

      // A generated name: deleted names stay reserved for 30 days.
      expect(created.serviceName).toMatch(
        new RegExp(`^alch-.*\\.endpoints\\.${project}\\.cloud\\.goog$`),
      );
      expect(created.producerProjectId).toEqual(project);
      expect(created.title).toEqual("Alchemy SM");

      const fetched = yield* servicemanagement.getServices({
        serviceName: created.serviceName,
      });
      expect(fetched.serviceName).toEqual(created.serviceName);
      expect(fetched.producerProjectId).toEqual(project);

      const config = yield* servicemanagement.listServicesConfigs({
        serviceName: created.serviceName,
        pageSize: 1,
      });
      // The title is shown in the API docs: no ownership marker.
      expect(config.serviceConfigs?.[0]?.title).toEqual("Alchemy SM");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ServiceManagement.Service("Hello", {
            title: "Alchemy SM v2",
          });
        }),
      );

      expect(updated.serviceName).toEqual(created.serviceName);
      expect(updated.title).toEqual("Alchemy SM v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.serviceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:servicemanagement", "live"],
    timeout: 600_000,
  },
);
