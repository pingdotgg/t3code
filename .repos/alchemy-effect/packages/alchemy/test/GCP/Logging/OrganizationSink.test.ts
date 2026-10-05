import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// Organization-scoped: set GOOGLE_ORGANIZATION_ID when the credentials
// administer the organization (the testing service account does not).
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim().replace(
  /^organizations\//,
  "",
);
const organization = `organizations/${organizationId}`;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  logging.getOrganizationsSinks({ sinkName: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsSinks on a missing sink fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getOrganizationsSinks({
          sinkName: `${organization}/sinks/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, replace, and delete an organization logging sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const destination = `logging.googleapis.com/${organization}/locations/global/buckets/_Default`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSink("Errors", {
            organization,
            destination,
            filter: "severity>=ERROR",
            description: "application errors",
          });
        }),
      );

      expect(created.sinkId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(`${organization}/sinks/${created.sinkId}`);
      expect(created.destination).toEqual(destination);
      expect(created.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("application errors");

      const fetched = yield* logging.getOrganizationsSinks({
        sinkName: created.name,
      });
      expect(fetched.destination).toEqual(destination);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSink("Errors", {
            organization,
            sinkId: created.sinkId,
            destination,
            filter: "severity>=WARNING",
            description: "warnings and errors",
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual("severity>=WARNING");
      expect(updated.disabled).toEqual(true);

      const last = created.sinkId.at(-1) ?? "a";
      const nextSinkId = `${created.sinkId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSink("Errors", {
            organization,
            sinkId: nextSinkId,
            destination,
            filter: "severity>=WARNING",
            description: "replaced sink",
          });
        }),
      );

      expect(replaced.sinkId).not.toEqual(created.sinkId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
