import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  parametermanager.getProjectsLocationsParametersVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const payloadOf = (data: string) =>
  Effect.sync(() => Buffer.from(data, "utf8").toString("base64"));

test.provider(
  "create, update, and delete a parameter version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {
            labels: { env: "test" },
          });
          const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
            parameter: parameter.name,
            data: "host=api.example.com",
          });
          return { parameter, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.parameter).toEqual(created.parameter.name);
      expect(created.version.disabled).toEqual(false);
      const expectedPayload = yield* payloadOf("host=api.example.com");
      expect(created.version.payloadData).toEqual(expectedPayload);

      const fetched =
        yield* parametermanager.getProjectsLocationsParametersVersions({
          name: created.version.name,
          view: "FULL",
        });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.disabled).toBeFalsy();
      expect(fetched.payload?.data).toEqual(created.version.payloadData);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {
            parameterId: created.parameter.parameterId,
            location: created.parameter.location,
            labels: { env: "test" },
          });
          const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
            parameter: parameter.name,
            parameterVersionId: created.version.parameterVersionId,
            data: "host=api.example.com",
            disabled: true,
          });
          return { parameter, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.disabled).toEqual(true);

      const fetchedUpdate =
        yield* parametermanager.getProjectsLocationsParametersVersions({
          name: created.version.name,
          view: "BASIC",
        });
      expect(fetchedUpdate.disabled).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "replace a parameter version when payload changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const parameter = yield* GCP.ParameterManager.Parameter(
            "AppConfig",
            {},
          );
          const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
            parameter: parameter.name,
            data: "first",
          });
          return { parameter, version };
        }),
      );

      const firstPayload = yield* payloadOf("first");
      expect(created.version.payloadData).toEqual(firstPayload);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const parameter = yield* GCP.ParameterManager.Parameter("AppConfig", {
            parameterId: created.parameter.parameterId,
            location: created.parameter.location,
          });
          const version = yield* GCP.ParameterManager.ParametersVersion("V1", {
            parameter: parameter.name,
            parameterVersionId: created.version.parameterVersionId,
            data: "second",
          });
          return { parameter, version };
        }),
      );

      expect(replaced.version.name).toEqual(created.version.name);
      const secondPayload = yield* payloadOf("second");
      expect(replaced.version.payloadData).toEqual(secondPayload);

      const fetched =
        yield* parametermanager.getProjectsLocationsParametersVersions({
          name: replaced.version.name,
          view: "FULL",
        });
      expect(fetched.payload?.data).toEqual(replaced.version.payloadData);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
    timeout: 90_000,
  },
);
