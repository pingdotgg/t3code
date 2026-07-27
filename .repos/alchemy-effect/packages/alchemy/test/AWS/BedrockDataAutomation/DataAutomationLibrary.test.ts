import * as AWS from "@/AWS";
import { DataAutomationLibrary } from "@/AWS/BedrockDataAutomation";
import * as Test from "@/Test/Alchemy";
import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const findLibrary = (libraryArn: string) =>
  bda.getDataAutomationLibrary({ libraryArn }).pipe(
    Effect.map((r) => r.library),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class LibraryStillExists extends Data.TaggedError("LibraryStillExists")<{
  readonly libraryArn: string;
}> {}

const assertLibraryDeleted = (libraryArn: string) =>
  findLibrary(libraryArn).pipe(
    Effect.flatMap((library) =>
      library === undefined
        ? Effect.void
        : Effect.fail(new LibraryStillExists({ libraryArn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "LibraryStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Sweep libraries leaked by interrupted probe/dev runs (deterministic names
// only — never touches libraries owned by other suites).
const sweepLeakedProbeLibraries = Effect.gen(function* () {
  const summaries = yield* bda.listDataAutomationLibraries
    .items({})
    .pipe(Stream.runCollect);
  yield* Effect.forEach(
    Array.from(summaries).filter(
      (s) =>
        s.libraryName !== undefined &&
        unredact(s.libraryName) === "alchemy-probe-lib",
    ),
    (s) =>
      bda
        .deleteDataAutomationLibrary({ libraryArn: s.libraryArn })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    { concurrency: 1 },
  );
});

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getDataAutomationLibrary on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { Account } = yield* sts.getCallerIdentity({});
      const region = yield* Effect.sync(
        () => process.env.AWS_REGION ?? "us-west-2",
      );
      const error = yield* Effect.flip(
        bda.getDataAutomationLibrary({
          libraryArn: `arn:aws:bedrock:${region}:${Account}:data-automation-library/nonexistentalchemyprobe0`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "create, update description, delete library",
  (stack) =>
    Effect.gen(function* () {
      yield* sweepLeakedProbeLibraries;
      yield* stack.destroy();

      const library = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataAutomationLibrary("TestLibrary", {
            libraryDescription: "alchemy test library",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(library.libraryArn).toContain(":data-automation-library/");
      expect(library.status).toBe("ACTIVE");

      // out-of-band verification via distilled
      const created = yield* findLibrary(library.libraryArn);
      expect(created).toBeDefined();
      expect(unredact(created!.libraryName)).toBe(library.libraryName);
      expect(unredact(created!.libraryDescription ?? "")).toBe(
        "alchemy test library",
      );
      const tags = yield* bda
        .listTagsForResource({ resourceARN: library.libraryArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.tags ?? []).map((t) => [t.key, t.value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestLibrary");

      // update the description in place — same physical library
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataAutomationLibrary("TestLibrary", {
            libraryDescription: "alchemy test library (updated)",
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.libraryArn).toBe(library.libraryArn);

      const afterUpdate = yield* findLibrary(library.libraryArn);
      expect(unredact(afterUpdate!.libraryDescription ?? "")).toBe(
        "alchemy test library (updated)",
      );

      yield* stack.destroy();
      yield* assertLibraryDeleted(library.libraryArn);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom library name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataAutomationLibrary("NamedLibrary", {
            libraryName: "alchemy-test-library-a",
          });
        }),
      );
      expect(first.libraryName).toBe("alchemy-test-library-a");

      // renaming triggers a replacement: new physical library, old one gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataAutomationLibrary("NamedLibrary", {
            libraryName: "alchemy-test-library-b",
          });
        }),
      );
      expect(second.libraryName).toBe("alchemy-test-library-b");
      expect(second.libraryArn).not.toBe(first.libraryArn);

      yield* assertLibraryDeleted(first.libraryArn);

      yield* stack.destroy();
      yield* assertLibraryDeleted(second.libraryArn);
    }),
  { timeout: 120_000 },
);
