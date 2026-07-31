import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord, unwrapRedactedString } from "./common.ts";

export interface SAMLProviderProps {
  /**
   * The friendly SAML provider name.
   */
  name: string;
  /**
   * The provider metadata document.
   */
  samlMetadataDocument: string;
  /**
   * Optional assertion encryption mode.
   */
  assertionEncryptionMode?: iam.AssertionEncryptionModeType;
  /**
   * Optional private key added during creation/update.
   */
  addPrivateKey?: Redacted.Redacted<string> | string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface SAMLProvider extends Resource<
  "AWS.IAM.SAMLProvider",
  SAMLProviderProps,
  {
    /** The ARN of the SAML provider. */
    samlProviderArn: string;
    /** The name of the SAML provider. */
    name: string;
    /** The unique ID AWS assigns to the provider. */
    samlProviderUUID: string | undefined;
    /** The SAML metadata document from the identity provider. */
    samlMetadataDocument: string | undefined;
    /** Whether SAML assertions must be encrypted (`Required` / `Allowed`). */
    assertionEncryptionMode: iam.AssertionEncryptionModeType | undefined;
    /** The tags applied to the provider. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM SAML identity provider.
 *
 * `SAMLProvider` registers a SAML metadata document so IAM roles can trust an
 * external workforce or application identity provider.
 * @resource
 * @section Federating with SAML
 * @example Create a SAML Identity Provider
 * ```typescript
 * const provider = yield* SAMLProvider("WorkforceSaml", {
 *   name: "workforce-saml",
 *   samlMetadataDocument: "<EntityDescriptor>...</EntityDescriptor>",
 * });
 * ```
 */
export const SAMLProvider = Resource<SAMLProvider>("AWS.IAM.SAMLProvider");

// IAM is eventually consistent. Recreating a SAML provider immediately after a
// same-named one was deleted (the destroy-then-deploy test flow) can transiently
// surface a content-less `ValidationError` (or `ConcurrentModificationException`)
// until the prior delete settles. A bounded retry rides out that window; a
// well-formed metadata document never fails persistently, so this never masks a
// genuine bad-input error for longer than the small budget.
const transientWriteSchedule = Schedule.max([
  Schedule.exponential(500).pipe(Schedule.jittered),
  Schedule.recurs(6),
]);
const isTransientWriteError = (error: {
  _tag: "ValidationError" | "ConcurrentModificationException" | (string & {});
}) =>
  error._tag === "ValidationError" ||
  error._tag === "ConcurrentModificationException";

export const SAMLProviderProvider = () =>
  Provider.succeed(SAMLProvider, {
    stables: ["samlProviderArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.name !== news.name) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response) {
        return undefined;
      }
      const tags = yield* iam.listSAMLProviderTags({
        SAMLProviderArn: output.samlProviderArn,
      });
      return {
        samlProviderArn: output.samlProviderArn,
        name: output.name,
        samlProviderUUID: response.SAMLProviderUUID,
        samlMetadataDocument: response.SAMLMetadataDocument,
        assertionEncryptionMode: response.AssertionEncryptionMode,
        tags: toTagRecord(tags.Tags),
      };
    }),
    list: Effect.fn(function* () {
      // IAM is global; `listSAMLProviders` enumerates every provider in the
      // account but only returns the ARN, so hydrate each via
      // `getSAMLProvider` + `listSAMLProviderTags` for the full Attributes.
      const { SAMLProviderList } = yield* iam.listSAMLProviders({});
      const arns = (SAMLProviderList ?? []).flatMap((entry) =>
        entry.Arn ? [entry.Arn] : [],
      );
      const rows = yield* Effect.forEach(
        arns,
        (samlProviderArn) =>
          Effect.gen(function* () {
            const response = yield* iam
              .getSAMLProvider({ SAMLProviderArn: samlProviderArn })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (!response) {
              return undefined;
            }
            const tags = yield* iam.listSAMLProviderTags({
              SAMLProviderArn: samlProviderArn,
            });
            return {
              samlProviderArn,
              name: samlProviderArn.split("saml-provider/").pop() ?? "",
              samlProviderUUID: response.SAMLProviderUUID,
              samlMetadataDocument: response.SAMLMetadataDocument,
              assertionEncryptionMode: response.AssertionEncryptionMode,
              tags: toTagRecord(tags.Tags),
            };
          }),
        { concurrency: 10 },
      );
      return rows.filter((row) => row !== undefined);
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const internalTags = yield* createInternalTags(id);
      const desiredTags = {
        ...internalTags,
        ...news.tags,
      };
      const accountId = (yield* AWSEnvironment.current).accountId;
      const samlProviderArn =
        output?.samlProviderArn ??
        `arn:aws:iam::${accountId}:saml-provider/${news.name}`;

      // Observe — `getSAMLProvider` returns the metadata, encryption
      // mode, and UUID; absence is `NoSuchEntityException`.
      let observed = yield* iam
        .getSAMLProvider({ SAMLProviderArn: samlProviderArn })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Ensure — create when missing. Race with a peer is recovered by
      // verifying alchemy ownership tags on the existing provider.
      if (!observed) {
        const created = yield* iam
          .createSAMLProvider({
            Name: news.name,
            SAMLMetadataDocument: news.samlMetadataDocument,
            AssertionEncryptionMode: news.assertionEncryptionMode,
            AddPrivateKey: news.addPrivateKey
              ? unwrapRedactedString(news.addPrivateKey)
              : undefined,
            Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          })
          .pipe(
            Effect.retry({
              while: isTransientWriteError,
              schedule: transientWriteSchedule,
            }),
            Effect.catchTag("EntityAlreadyExistsException", () =>
              Effect.gen(function* () {
                const existingTags = yield* iam.listSAMLProviderTags({
                  SAMLProviderArn: samlProviderArn,
                });
                if (!hasTags(internalTags, existingTags.Tags)) {
                  return yield* Effect.fail(
                    new Error(
                      `SAML provider '${news.name}' already exists and is not managed by alchemy`,
                    ),
                  );
                }
                return { SAMLProviderArn: samlProviderArn };
              }),
            ),
          );
        observed = yield* iam.getSAMLProvider({
          SAMLProviderArn: created.SAMLProviderArn ?? samlProviderArn,
        });
      } else {
        // Sync metadata / encryption mode — `updateSAMLProvider` is a
        // partial update; only push the doc when it actually differs.
        if (
          (observed.SAMLMetadataDocument ?? undefined) !==
            news.samlMetadataDocument ||
          observed.AssertionEncryptionMode !== news.assertionEncryptionMode ||
          news.addPrivateKey !== undefined
        ) {
          yield* iam
            .updateSAMLProvider({
              SAMLProviderArn: samlProviderArn,
              SAMLMetadataDocument:
                (observed.SAMLMetadataDocument ?? undefined) !==
                news.samlMetadataDocument
                  ? news.samlMetadataDocument
                  : undefined,
              AssertionEncryptionMode: news.assertionEncryptionMode,
              AddPrivateKey: news.addPrivateKey
                ? unwrapRedactedString(news.addPrivateKey)
                : undefined,
            })
            .pipe(
              Effect.retry({
                while: isTransientWriteError,
                schedule: transientWriteSchedule,
              }),
            );
        }
      }

      // Sync tags against the cloud's actual tags.
      const observedTagsResp = yield* iam.listSAMLProviderTags({
        SAMLProviderArn: samlProviderArn,
      });
      const observedTags = toTagRecord(observedTagsResp.Tags);
      const { removed, upsert } = diffTags(observedTags, desiredTags);
      if (upsert.length > 0) {
        yield* iam.tagSAMLProvider({
          SAMLProviderArn: samlProviderArn,
          Tags: upsert,
        });
      }
      if (removed.length > 0) {
        yield* iam.untagSAMLProvider({
          SAMLProviderArn: samlProviderArn,
          TagKeys: removed,
        });
      }

      yield* session.note(samlProviderArn);
      return {
        samlProviderArn,
        name: news.name,
        samlProviderUUID:
          observed?.SAMLProviderUUID ?? output?.samlProviderUUID,
        samlMetadataDocument: news.samlMetadataDocument,
        assertionEncryptionMode: news.assertionEncryptionMode,
        tags: desiredTags,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSAMLProvider({
          SAMLProviderArn: output.samlProviderArn,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
