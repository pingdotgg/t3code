import * as AWS from "@/AWS";
import { InstrumentationConfiguration } from "@/AWS/ApplicationSignals";
import * as Test from "@/Test/Alchemy";
import * as appsignals from "@distilled.cloud/aws/application-signals";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// The instrumented service does not need to exist — configurations are
// stored server-side and picked up by SDK agents on their next sync.
const SERVICE = "alchemy-test-appsignals-ic";
const ENVIRONMENT = "alchemy-test-env";

const location = (lineNumber: number): appsignals.CodeLocation => ({
  Language: "Python",
  CodeUnit: "app.main",
  MethodName: "handler",
  FilePath: "app/main.py",
  LineNumber: lineNumber,
});

const getConfiguration = (locationHash: string) =>
  appsignals
    .getInstrumentationConfiguration({
      InstrumentationType: "PROBE",
      Service: SERVICE,
      Environment: ENVIRONMENT,
      SignalType: "SNAPSHOT",
      LocationIdentifier: { LocationHash: locationHash },
    })
    .pipe(Effect.map((r) => r.Configuration));

const assertGone = (locationHash: string) =>
  getConfiguration(locationHash).pipe(
    Effect.flatMap((c) =>
      Effect.fail(new Error(`configuration '${c.LocationHash}' still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

test.provider(
  "create, update tags in place, replace on location change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        instrumentationType: "PROBE",
        service: SERVICE,
        environment: ENVIRONMENT,
        signalType: "SNAPSHOT",
        captureConfiguration: {
          CaptureLocals: ["x"],
          CaptureLimits: { MaxHits: 5 },
        } satisfies appsignals.CodeCaptureConfiguration,
      };

      // CREATE
      const { probe } = yield* stack.deploy(
        Effect.gen(function* () {
          const probe = yield* InstrumentationConfiguration("Probe", {
            ...props,
            location: location(10),
            description: "alchemy instrumentation configuration test",
            tags: { fixture: "application-signals-ic" },
          });
          return { probe };
        }),
      );

      expect(probe.arn).toContain(":instrumentationConfig/");
      expect(probe.locationHash).toBeTruthy();
      expect(probe.service).toBe(SERVICE);

      const observed = yield* getConfiguration(probe.locationHash);
      expect(observed.ARN).toBe(probe.arn);
      expect(observed.Description).toBe(
        "alchemy instrumentation configuration test",
      );

      // Tags: user tag + internal Alchemy branding.
      const tags = yield* appsignals
        .listTagsForResource({ ResourceArn: probe.arn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.fixture).toBe("application-signals-ic");
      expect(tags["alchemy::id"]).toBe("Probe");

      // UPDATE IN PLACE — configurations are immutable, but tags are not.
      const { probe: retagged } = yield* stack.deploy(
        Effect.gen(function* () {
          const probe = yield* InstrumentationConfiguration("Probe", {
            ...props,
            location: location(10),
            description: "alchemy instrumentation configuration test",
            tags: { fixture: "application-signals-ic", updated: "true" },
          });
          return { probe };
        }),
      );
      expect(retagged.arn).toBe(probe.arn);
      const updatedTags = yield* appsignals
        .listTagsForResource({ ResourceArn: probe.arn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(updatedTags.updated).toBe("true");

      // REPLACE — changing the code location replaces the configuration.
      const { probe: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const probe = yield* InstrumentationConfiguration("Probe", {
            ...props,
            location: location(20),
            description: "alchemy instrumentation configuration test",
            tags: { fixture: "application-signals-ic" },
          });
          return { probe };
        }),
      );
      expect(replaced.locationHash).not.toBe(probe.locationHash);
      yield* assertGone(probe.locationHash);

      // DESTROY
      yield* stack.destroy();
      yield* assertGone(replaced.locationHash);
    }),
  { timeout: 120_000 },
);
