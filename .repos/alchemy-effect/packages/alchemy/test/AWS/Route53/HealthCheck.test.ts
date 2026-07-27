import * as AWS from "@/AWS";
import { HealthCheck } from "@/AWS/Route53";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertCheckGone = (id: string) =>
  route53.getHealthCheck({ HealthCheckId: id }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("health check still exists"))),
    Effect.catchTag("NoSuchHealthCheck", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update in place, tag, and delete health check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const check = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HealthCheck("Check", {
            type: "HTTP",
            fullyQualifiedDomainName: "example.com",
            resourcePath: "/",
            port: 80,
            requestInterval: "30 seconds",
            failureThreshold: 3,
            tags: { env: "test" },
          });
        }),
      );

      expect(check.id).toBeDefined();
      expect(check.healthCheckId).toBe(check.id);
      expect(check.type).toBe("HTTP");

      const observed = yield* route53.getHealthCheck({
        HealthCheckId: check.id,
      });
      expect(observed.HealthCheck.HealthCheckConfig.FailureThreshold).toBe(3);
      expect(observed.HealthCheck.HealthCheckConfig.ResourcePath).toBe("/");
      // Duration.Input prop round-trips to the wire as integer seconds.
      expect(observed.HealthCheck.HealthCheckConfig.RequestInterval).toBe(30);

      const tags = yield* route53.listTagsForResource({
        ResourceType: "healthcheck",
        ResourceId: check.id,
      });
      const tagMap = Object.fromEntries(
        (tags.ResourceTagSet.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap.env).toBe("test");
      expect(tagMap["alchemy::id"]).toBeDefined();

      // Update mutable fields in place (version-locked).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HealthCheck("Check", {
            type: "HTTP",
            fullyQualifiedDomainName: "example.com",
            resourcePath: "/health",
            port: 80,
            requestInterval: "30 seconds",
            failureThreshold: 5,
            tags: { env: "prod" },
          });
        }),
      );
      // In-place update keeps the same id.
      expect(updated.id).toBe(check.id);

      const observed2 = yield* route53.getHealthCheck({
        HealthCheckId: check.id,
      });
      expect(observed2.HealthCheck.HealthCheckConfig.FailureThreshold).toBe(5);
      expect(observed2.HealthCheck.HealthCheckConfig.ResourcePath).toBe(
        "/health",
      );

      const tags2 = yield* route53.listTagsForResource({
        ResourceType: "healthcheck",
        ResourceId: check.id,
      });
      const tagMap2 = Object.fromEntries(
        (tags2.ResourceTagSet.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap2.env).toBe("prod");

      yield* stack.destroy();
      yield* assertCheckGone(check.id);
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing Type replaces the health check",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const check = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HealthCheck("ReplaceCheck", {
            type: "HTTP",
            fullyQualifiedDomainName: "example.com",
            port: 80,
            requestInterval: "30 seconds",
          });
        }),
      );
      const originalId = check.id;

      // Type is immutable — changing it forces replacement (new id).
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HealthCheck("ReplaceCheck", {
            type: "HTTPS",
            fullyQualifiedDomainName: "example.com",
            port: 443,
            requestInterval: "30 seconds",
          });
        }),
      );

      expect(replaced.type).toBe("HTTPS");
      expect(replaced.id).not.toBe(originalId);

      // The old health check must have been deleted.
      yield* assertCheckGone(originalId);

      yield* stack.destroy();
      yield* assertCheckGone(replaced.id);
    }),
  { timeout: 180_000 },
);
