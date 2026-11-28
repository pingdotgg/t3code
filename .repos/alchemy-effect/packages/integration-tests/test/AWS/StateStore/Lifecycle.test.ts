import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemist from "alchemy/Alchemist";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: AWS.providers() });

/** Run with `CI` set, as a CI deploy would. */
const inCI = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.CI;
      process.env.CI = "true";
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.CI;
        else process.env.CI = previous;
      }),
  );

const bucketExists = (bucket: string) =>
  s3.headBucket({ Bucket: bucket }).pipe(
    Effect.as(true),
    Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
  );

test.provider(
  "a named S3 state store bootstraps, serves state and tears down",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // Never the default store, which every other run on the account uses.
      const name = "lifecycle";
      const bucket = `alchemy-state-lifecycle-${accountId}-${region}-an`;
      const target = { type: "provider", backend: "aws-s3", name } as const;
      const alchemist = Alchemist.layer();

      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* bucketExists(bucket)).toBe(true);
      expect((yield* s3.getBucketVersioning({ Bucket: bucket })).Status).toBe("Enabled");

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual([]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([bucket]);
      expect(yield* bucketExists(bucket)).toBe(false);

      const again = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(again.deleted).toEqual([]);

      // In CI, a missing store fails instead of being created on first use.
      const inCi = yield* inCI(
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      );
      expect(Exit.isFailure(inCi)).toBe(true);
      if (Exit.isFailure(inCi)) {
        expect(Cause.pretty(inCi.cause)).toContain(
          `Run 'alchemy state bootstrap --backend aws-s3 --name ${name}`,
        );
      }
      expect(yield* bucketExists(bucket)).toBe(false);
    }),
  // Exclusive: sets `CI` on the process.
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 180_000,
    exclusive: true,
  },
);
