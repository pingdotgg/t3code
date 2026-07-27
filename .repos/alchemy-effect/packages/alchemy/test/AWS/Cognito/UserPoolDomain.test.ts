import * as AWS from "@/AWS";
import { UserPool, UserPoolDomain } from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class DomainStillExists extends Data.TaggedError("DomainStillExists")<{
  readonly domain: string;
}> {}

const assertDomainDeleted = (domain: string) =>
  cip.describeUserPoolDomain({ Domain: domain }).pipe(
    Effect.flatMap((r) =>
      r.DomainDescription?.UserPoolId === undefined
        ? Effect.void
        : Effect.fail(new DomainStillExists({ domain })),
    ),
    Effect.retry({
      while: (e) => e._tag === "DomainStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "cognito-prefix domain lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("DomainTestPool", {});
          const domain = yield* UserPoolDomain("AuthDomain", {
            userPoolId: pool.userPoolId,
          });
          return { pool, domain };
        }),
      );

      expect(outputs.domain.domain).toMatch(/^[a-z0-9-]+$/);
      expect(outputs.domain.domain).not.toContain("cognito");
      expect(outputs.domain.domain).not.toContain("aws");
      expect(outputs.domain.userPoolId).toBe(outputs.pool.userPoolId);
      expect(outputs.domain.cloudFrontDomain).toBeTruthy();

      // out-of-band verification via distilled
      const described = yield* cip.describeUserPoolDomain({
        Domain: outputs.domain.domain,
      });
      expect(described.DomainDescription?.UserPoolId).toBe(
        outputs.pool.userPoolId,
      );
      expect(described.DomainDescription?.Status).toBe("ACTIVE");

      // no-op deploy converges without error
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("DomainTestPool", {});
          const domain = yield* UserPoolDomain("AuthDomain", {
            userPoolId: pool.userPoolId,
          });
          return { pool, domain };
        }),
      );
      expect(noop.domain.domain).toBe(outputs.domain.domain);

      yield* stack.destroy();
      yield* assertDomainDeleted(outputs.domain.domain);
    }),
  { timeout: 180_000 },
);
