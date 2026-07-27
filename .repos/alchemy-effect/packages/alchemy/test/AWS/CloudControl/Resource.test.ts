import * as AWS from "@/AWS";
import { Resource as CloudControlResource } from "@/AWS/CloudControl";
import * as Test from "@/Test/Alchemy";
import * as CloudControl from "@distilled.cloud/aws/cloudcontrol";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class ResourceStillExists extends Data.TaggedError("ResourceStillExists") {}

const readValue = (
  properties: string | Redacted.Redacted<string> | undefined,
): string | undefined => {
  const raw =
    properties === undefined || typeof properties === "string"
      ? properties
      : Redacted.value(properties);
  if (raw === undefined) return undefined;
  return (JSON.parse(raw) as { Value?: string }).Value;
};

const assertDeleted = Effect.fn(function* (name: string) {
  yield* CloudControl.getResource({
    TypeName: "AWS::SSM::Parameter",
    Identifier: name,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new ResourceStillExists())),
    Effect.retry({
      while: (e) => e._tag === "ResourceStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

// A deterministic, free SSM parameter name unique to this test.
const paramName = "/alchemy-test/cloudcontrol/greeting";

const resourceDef = (value: string) =>
  Effect.gen(function* () {
    const param = yield* CloudControlResource("CcParam", {
      typeName: "AWS::SSM::Parameter",
      desiredState: { Name: paramName, Type: "String", Value: value },
    });
    return { param };
  });

test.provider(
  "create, update (JSON patch), delete an SSM parameter via Cloud Control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { param: created } = yield* stack.deploy(resourceDef("hello"));
      expect(created.identifier).toBe(paramName);
      expect(created.typeName).toBe("AWS::SSM::Parameter");
      expect(created.properties.Value).toBe("hello");

      // Verify out-of-band.
      const described = yield* CloudControl.getResource({
        TypeName: "AWS::SSM::Parameter",
        Identifier: paramName,
      });
      expect(readValue(described.ResourceDescription?.Properties)).toBe(
        "hello",
      );

      // Update the value — a JSON Patch is computed over just the Value key.
      const { param: updated } = yield* stack.deploy(resourceDef("world"));
      expect(updated.identifier).toBe(paramName);
      expect(updated.properties.Value).toBe("world");

      const reDescribed = yield* CloudControl.getResource({
        TypeName: "AWS::SSM::Parameter",
        Identifier: paramName,
      });
      expect(readValue(reDescribed.ResourceDescription?.Properties)).toBe(
        "world",
      );

      // Delete + wait gone.
      yield* stack.destroy();
      yield* assertDeleted(paramName);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
