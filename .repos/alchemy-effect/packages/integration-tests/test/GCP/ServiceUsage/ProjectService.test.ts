import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as serviceusage from "@distilled.cloud/gcp/serviceusage_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// An API no other suite uses, so disabling it cannot break a concurrent test.
const THROWAWAY_API = "kgsearch.googleapis.com";

const stateOf = (project: string, service: string) =>
  serviceusage
    .getServices({ name: `projects/${project}/services/${service}` })
    .pipe(Effect.map((current) => current.state));

const waitUntilDisabled = (project: string, service: string) =>
  stateOf(project, service).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (state) => state === "DISABLED",
      times: 10,
    }),
  );

test.provider(
  "adopts an enabled API and leaves it enabled on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const enabled = yield* stack.deploy(
        GCP.ServiceUsage.ProjectService("ServiceUsageApi", {
          service: "serviceusage.googleapis.com",
        }),
      );

      expect(enabled.project).toEqual(project);
      expect(enabled.service).toEqual("serviceusage.googleapis.com");
      expect(enabled.state).toEqual("ENABLED");
      expect(enabled.disableOnDestroy).toEqual(false);
      expect(yield* stateOf(project, enabled.service)).toEqual("ENABLED");

      yield* stack.destroy();

      expect(yield* stateOf(project, enabled.service)).toEqual("ENABLED");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:serviceusage", "live"], timeout: 120_000 },
);

test.provider(
  "enables an API and disables it on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const enabled = yield* stack.deploy(
        GCP.ServiceUsage.ProjectService("ThrowawayApi", {
          service: THROWAWAY_API,
          disableOnDestroy: true,
        }),
      );

      expect(enabled.service).toEqual(THROWAWAY_API);
      expect(enabled.state).toEqual("ENABLED");
      expect(enabled.disableOnDestroy).toEqual(true);
      expect(yield* stateOf(project, THROWAWAY_API)).toEqual("ENABLED");

      yield* stack.destroy();

      expect(yield* waitUntilDisabled(project, THROWAWAY_API)).toEqual("DISABLED");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:serviceusage", "live"], timeout: 120_000 },
);
