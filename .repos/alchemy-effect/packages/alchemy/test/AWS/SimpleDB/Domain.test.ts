import * as AWS from "@/AWS";
import { Domain } from "@/AWS/SimpleDB";
import * as Test from "@/Test/Alchemy";
import * as sdb from "@distilled.cloud/aws/simpledb";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findDomain = (domainName: string) =>
  sdb
    .domainMetadata({ DomainName: domainName })
    .pipe(Effect.catchTag("NoSuchDomain", () => Effect.succeed(undefined)));

class DomainStillExists extends Data.TaggedError("DomainStillExists")<{
  readonly domainName: string;
}> {}

const assertDomainDeleted = (domainName: string) =>
  findDomain(domainName).pipe(
    Effect.flatMap((metadata) =>
      metadata === undefined
        ? Effect.void
        : Effect.fail(new DomainStillExists({ domainName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "DomainStillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create and delete a domain (generated name)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domain = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Domain("TestSdbDomain", {});
        }),
      );

      expect(domain.domainName).toBeDefined();
      expect(domain.domainArn).toContain(":domain/");
      expect(domain.domainArn).toContain(domain.domainName);

      // out-of-band verification via distilled
      const metadata = yield* findDomain(domain.domainName);
      expect(metadata).toBeDefined();
      expect(metadata?.ItemCount).toBe(0);

      // idempotent re-deploy: same physical domain
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Domain("TestSdbDomain", {});
        }),
      );
      expect(again.domainName).toBe(domain.domainName);
      expect(again.domainArn).toBe(domain.domainArn);

      yield* stack.destroy();
      yield* assertDomainDeleted(domain.domainName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "explicit name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Domain("NamedSdbDomain", {
            domainName: "alchemy-test-simpledb-a",
          });
        }),
      );
      expect(first.domainName).toBe("alchemy-test-simpledb-a");

      // renaming triggers a replacement: new physical domain, old gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Domain("NamedSdbDomain", {
            domainName: "alchemy-test-simpledb-b",
          });
        }),
      );
      expect(second.domainName).toBe("alchemy-test-simpledb-b");
      expect(second.domainArn).not.toBe(first.domainArn);

      yield* assertDomainDeleted(first.domainName);

      yield* stack.destroy();
      yield* assertDomainDeleted(second.domainName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "domainMetadata on a missing domain fails with typed NoSuchDomain",
  () =>
    Effect.gen(function* () {
      const error = yield* sdb
        .domainMetadata({ DomainName: "alchemy-test-simpledb-bogus" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("NoSuchDomain");
    }),
  { timeout: 60_000 },
);
