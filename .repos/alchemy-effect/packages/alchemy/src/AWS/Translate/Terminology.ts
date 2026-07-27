import * as translate from "@distilled.cloud/aws/translate";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readTranslateTags, syncTranslateTags } from "./internal.ts";

export interface TerminologyProps {
  /**
   * Name of the terminology — up to 256 characters of letters, digits, and
   * hyphens (`^([A-Za-z0-9-]_?)+$`). If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * terminology.
   */
  terminologyName?: string;
  /**
   * Description of the terminology.
   */
  description?: string;
  /**
   * The terminology file content — term pairs in the given `format`. For
   * `CSV`, the first row is the language-code header (e.g. `en,es`) and each
   * subsequent row is a term pair. Updatable in place — `ImportTerminology`
   * is a true upsert (`MergeStrategy: OVERWRITE`); an overwrite takes up to
   * 10 minutes to fully propagate to translations.
   */
  file: string;
  /**
   * Format of the terminology `file`: `CSV`, `TMX`, or `TSV`.
   */
  format: "CSV" | "TMX" | "TSV";
  /**
   * Directionality of the terminology: `UNI` (source→targets, the default)
   * or `MULTI` (any listed language is a valid source).
   * @default "UNI"
   */
  directionality?: "UNI" | "MULTI";
  /**
   * Id of the customer-managed KMS key used to encrypt the terminology.
   * If omitted, Translate uses an AWS-owned key.
   */
  encryptionKeyId?: string;
  /**
   * User-defined tags for the terminology.
   */
  tags?: Record<string, string>;
}

export interface Terminology extends Resource<
  "AWS.Translate.Terminology",
  TerminologyProps,
  {
    /**
     * Name of the terminology — pass it as `TerminologyNames` to
     * `TranslateText`/`TranslateDocument` or batch translation jobs.
     */
    terminologyName: string;
    /**
     * ARN of the terminology, e.g.
     * `arn:aws:translate:us-east-1:123456789012:terminology/brand-glossary`.
     */
    terminologyArn: string;
    /** Source language code declared by the terminology file, e.g. `en`. */
    sourceLanguageCode: string | undefined;
    /** Target language codes declared by the terminology file. */
    targetLanguageCodes: string[] | undefined;
    /** Number of terms imported. */
    termCount: number | undefined;
    /** Number of terms skipped during import (malformed rows). */
    skippedTermCount: number | undefined;
    /** Size of the imported file in bytes. */
    sizeBytes: number | undefined;
    /** Directionality of the terminology (`UNI` or `MULTI`). */
    directionality: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Translate custom terminology — a glossary of term pairs (CSV,
 * TMX, or TSV) that pins how specific words and phrases (brand names,
 * product names, domain jargon) are translated. Reference it by name from
 * `TranslateText`, `TranslateDocument`, or batch translation jobs.
 *
 * @resource
 * @section Managing Terminologies
 * @example Import a CSV terminology
 * ```typescript
 * const glossary = yield* AWS.Translate.Terminology("BrandGlossary", {
 *   file: ["en,es", "Alchemy,Alquimia"].join("\n"),
 *   format: "CSV",
 * });
 * ```
 *
 * @example Translate text with the terminology applied
 * ```typescript
 * const translateText = yield* AWS.Translate.TranslateText();
 * const result = yield* translateText({
 *   Text: "Alchemy deploys infrastructure.",
 *   SourceLanguageCode: "en",
 *   TargetLanguageCode: "es",
 *   TerminologyNames: [glossary.terminologyName],
 * });
 * ```
 */
export const Terminology = Resource<Terminology>("AWS.Translate.Terminology");

const toAttributes = (props: translate.TerminologyProperties) => ({
  terminologyName: props.Name!,
  terminologyArn: props.Arn!,
  sourceLanguageCode: props.SourceLanguageCode,
  targetLanguageCodes: props.TargetLanguageCodes
    ? [...props.TargetLanguageCodes]
    : undefined,
  termCount: props.TermCount,
  skippedTermCount: props.SkippedTermCount,
  sizeBytes: props.SizeBytes,
  directionality: props.Directionality,
});

export const TerminologyProvider = () =>
  Provider.effect(
    Terminology,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: TerminologyProps,
      ) {
        // Translate names must match ^([A-Za-z0-9-]_?)+$ (≤ 256 chars);
        // createPhysicalName's hyphenated output satisfies it directly.
        return (
          props.terminologyName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const getOne = Effect.fn(function* (name: string) {
        return yield* translate
          .getTerminology({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["terminologyName", "terminologyArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* createName(id, olds)) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.terminologyName ??
            (yield* createName(id, olds ?? { file: "", format: "CSV" }));
          const found = yield* getOne(name);
          if (found?.TerminologyProperties === undefined) return undefined;
          const attrs = toAttributes(found.TerminologyProperties);
          const tags = yield* readTranslateTags(attrs.terminologyArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const name = output?.terminologyName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative.
          const observed = yield* getOne(name);

          // GetTerminology returns a presigned download location rather than
          // the file content, so `olds` is the hint for skipping a no-op
          // import; adoption (olds undefined) always imports to converge.
          const changed =
            olds === undefined ||
            olds.file !== news.file ||
            olds.format !== news.format ||
            (olds.directionality ?? "UNI") !== (news.directionality ?? "UNI") ||
            (olds.description ?? undefined) !==
              (news.description ?? undefined) ||
            (olds.encryptionKeyId ?? undefined) !==
              (news.encryptionKeyId ?? undefined);

          if (observed?.TerminologyProperties === undefined || changed) {
            const bytes = yield* Effect.sync(() =>
              new TextEncoder().encode(news.file),
            );
            yield* translate.importTerminology({
              Name: name,
              MergeStrategy: "OVERWRITE",
              Description: news.description,
              TerminologyData: {
                // The File schema is a SensitiveBlob — the encoder unwraps
                // the Redacted back to raw bytes on the wire.
                File: Redacted.make(bytes),
                Format: news.format,
                Directionality: news.directionality,
              },
              EncryptionKey: news.encryptionKeyId
                ? { Type: "KMS", Id: news.encryptionKeyId }
                : undefined,
            });
          }

          const final = yield* getOne(name);
          const attrs = toAttributes(final!.TerminologyProperties!);
          yield* session.note(name);
          yield* syncTranslateTags(attrs.terminologyArn, desiredTags);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the terminology may already be gone.
          yield* translate
            .deleteTerminology({ Name: output.terminologyName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          translate.listTerminologies.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.TerminologyPropertiesList ?? [])
                .filter((props) => props.Name && props.Arn)
                .map(toAttributes),
            ),
          ),
      };
    }),
  );
