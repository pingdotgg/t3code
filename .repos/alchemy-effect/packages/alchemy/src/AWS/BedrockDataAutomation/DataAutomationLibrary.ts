import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readBdaTags,
  syncBdaTags,
  toBdaTagList,
  unredact,
} from "./internal.ts";

// Explicitly-typed pipeable repeat helper. Inlining `Effect.repeat` in a
// provider lifecycle op leaks its conditional return type into declaration
// emit and widens the provider layer for every consumer of `AWS.providers()`.
const repeatUntilLibraryGone = <E, R>(
  self: Effect.Effect<bda.DataAutomationLibrary | undefined, E, R>,
): Effect.Effect<bda.DataAutomationLibrary | undefined, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.fixed("3 seconds"),
    until: (library) => library === undefined,
    times: 10,
  });

export interface DataAutomationLibraryProps {
  /**
   * Name of the library. Changing the name replaces the library (the API has
   * no rename operation).
   * @default ${app}-${stage}-${id}
   */
  libraryName?: string;
  /**
   * Human-readable description of the library. Mutable in place.
   */
  libraryDescription?: string;
  /**
   * Customer-managed KMS encryption for the library. Create-only — changing
   * the key replaces the library. When omitted, the service uses an
   * AWS-owned key.
   */
  encryptionConfiguration?: bda.EncryptionConfiguration;
  /**
   * Tags to apply to the library. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface DataAutomationLibrary extends Resource<
  "AWS.BedrockDataAutomation.DataAutomationLibrary",
  DataAutomationLibraryProps,
  {
    /**
     * The ARN of the library.
     */
    libraryArn: string;
    /**
     * Name of the library.
     */
    libraryName: string;
    /**
     * Current status of the library (`ACTIVE` or `DELETING`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Bedrock Data Automation Library — a store of reusable entities
 * (currently `VOCABULARY` entities: domain phrases with display forms) that
 * data automation projects reference via their
 * `dataAutomationLibraryConfiguration` to improve extraction accuracy.
 *
 * Entities are loaded into the library with ingestion jobs — see the
 * `InvokeDataAutomationLibraryIngestionJob` binding.
 *
 * @resource
 * @section Creating Libraries
 * @example Library with a description
 * ```typescript
 * import * as BDA from "alchemy/AWS/BedrockDataAutomation";
 *
 * const library = yield* BDA.DataAutomationLibrary("Vocab", {
 *   libraryDescription: "domain vocabulary for invoice extraction",
 * });
 * ```
 *
 * @example Reference the library from a project
 * ```typescript
 * const project = yield* BDA.DataAutomationProject("Docs", {
 *   standardOutputConfiguration: {},
 *   dataAutomationLibraryConfiguration: {
 *     libraries: [{ libraryArn: library.libraryArn }],
 *   },
 * });
 * ```
 */
export const DataAutomationLibrary = Resource<DataAutomationLibrary>(
  "AWS.BedrockDataAutomation.DataAutomationLibrary",
);

/**
 * Raised when a Data Automation library cannot be observed immediately after
 * a successful create — a race with a concurrent delete.
 */
export class DataAutomationLibraryNotObservable extends Data.TaggedError(
  "DataAutomationLibraryNotObservable",
)<{ libraryName: string; message: string }> {}

export const DataAutomationLibraryProvider = () =>
  Provider.effect(
    DataAutomationLibrary,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<DataAutomationLibraryProps, "libraryName">,
      ) {
        return (
          props.libraryName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const toAttributes = (library: bda.DataAutomationLibrary) => ({
        libraryArn: library.libraryArn,
        libraryName: unredact(library.libraryName),
        status: library.status as string,
      });

      const observeLibrary = Effect.fn(function* (libraryArn: string) {
        return yield* bda.getDataAutomationLibrary({ libraryArn }).pipe(
          Effect.map((r) => r.library),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const findLibraryArn = Effect.fn(function* (name: string) {
        const summaries = yield* bda.listDataAutomationLibraries
          .items({})
          .pipe(Stream.runCollect);
        return Array.from(summaries).find(
          (s) =>
            s.libraryName !== undefined && unredact(s.libraryName) === name,
        )?.libraryArn;
      });

      return DataAutomationLibrary.Provider.of({
        stables: ["libraryArn", "libraryName"],

        list: () =>
          Effect.gen(function* () {
            const summaries = yield* bda.listDataAutomationLibraries
              .items({})
              .pipe(Stream.runCollect);
            const attrs = yield* Effect.forEach(
              Array.from(summaries),
              (s) =>
                observeLibrary(s.libraryArn).pipe(
                  Effect.map((library) =>
                    library === undefined ? [] : [toAttributes(library)],
                  ),
                ),
              { concurrency: 5 },
            );
            return attrs.flat();
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const libraryArn =
            output?.libraryArn ??
            (yield* findLibraryArn(yield* createName(id, olds ?? {})));
          if (libraryArn === undefined) return undefined;
          const found = yield* observeLibrary(libraryArn);
          if (found === undefined) return undefined;
          const attrs = toAttributes(found);
          const tags = yield* readBdaTags(libraryArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (
            oldName !== newName ||
            // updateDataAutomationLibrary only takes a description, so a KMS
            // key change can only be honored by replacement.
            olds?.encryptionConfiguration?.kmsKeyId !==
              news.encryptionConfiguration?.kmsKeyId
          ) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const libraryName =
            output?.libraryName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output caches the ARN.
          const cachedArn =
            output?.libraryArn ?? (yield* findLibraryArn(libraryName));
          let live =
            cachedArn === undefined
              ? undefined
              : yield* observeLibrary(cachedArn);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    the typed ConflictException, which we treat as a race and
          //    re-observe by name. Create returns only arn + status, so
          //    re-observe for the full shape.
          if (live === undefined) {
            const createdArn = yield* bda
              .createDataAutomationLibrary({
                libraryName,
                libraryDescription: news.libraryDescription,
                encryptionConfiguration: news.encryptionConfiguration,
                tags: toBdaTagList(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.libraryArn),
                Effect.catchTag("ConflictException", (conflict) =>
                  Effect.gen(function* () {
                    const arn = yield* findLibraryArn(libraryName);
                    return arn === undefined
                      ? yield* Effect.fail(conflict)
                      : arn;
                  }),
                ),
              );
            live =
              createdArn === undefined
                ? undefined
                : yield* observeLibrary(createdArn);
          }
          if (live === undefined) {
            return yield* Effect.fail(
              new DataAutomationLibraryNotObservable({
                libraryName,
                message: `Data Automation library '${libraryName}' was not observable after create`,
              }),
            );
          }

          // 3. SYNC — diff the OBSERVED description against the desired one;
          //    apply the idempotent update only on drift.
          if (
            unredact(live.libraryDescription ?? "") !==
            (news.libraryDescription ?? "")
          ) {
            yield* bda.updateDataAutomationLibrary({
              libraryArn: live.libraryArn,
              libraryDescription: news.libraryDescription ?? "",
            });
            live = (yield* observeLibrary(live.libraryArn)) ?? live;
          }

          // 3b. SYNC TAGS against observed cloud tags.
          yield* syncBdaTags(live.libraryArn, desiredTags);

          yield* session.note(libraryName);
          return toAttributes(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* bda
            .deleteDataAutomationLibrary({ libraryArn: output.libraryArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          // Deletion settles asynchronously (status ACTIVE → DELETING → gone)
          // and library names are unique, so wait for the terminal
          // disappearance — otherwise an immediate same-name re-create
          // conflicts with the vanishing library. Bounded: 10 × 3s ≈ 30s.
          yield* observeLibrary(output.libraryArn).pipe(repeatUntilLibraryGone);
        }),
      });
    }),
  );
