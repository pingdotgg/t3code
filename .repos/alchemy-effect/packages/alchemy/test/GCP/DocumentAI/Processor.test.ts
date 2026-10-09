import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const location = "us";

const waitUntilGone = (name: string) =>
  documentai.getProjectsLocationsProcessors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsProcessors on a missing processor fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        documentai.getProjectsLocationsProcessors({
          name: `${parent}/processors/alchemy-missing-processor`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:documentai", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a processor",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DocumentAI.Processor("Ocr", {
            location,
            type: "OCR_PROCESSOR",
            displayName: "ocr",
          });
        }),
      );

      expect(created.processorId).toEqual(expect.any(String));
      expect(created.name).toContain("/processors/");
      expect(created.location).toEqual(location);
      expect(created.type).toEqual("OCR_PROCESSOR");
      expect(created.displayName).toEqual("ocr");
      expect(created.state).toEqual("ENABLED");

      const fetched = yield* documentai.getProjectsLocationsProcessors({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("OCR_PROCESSOR");
      expect(fetched.displayName).toContain("ocr");
      expect(fetched.displayName).toMatch(/\[alc |\[alchemy /);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DocumentAI.Processor("Ocr", {
            processorId: created.processorId,
            location,
            type: "OCR_PROCESSOR",
            displayName: "ocr",
            enabled: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.state).toEqual("DISABLED");

      const disabled = yield* documentai.getProjectsLocationsProcessors({
        name: created.name,
      });
      expect(disabled.state).toEqual("DISABLED");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:documentai", "live"],
    timeout: 120_000,
  },
);
