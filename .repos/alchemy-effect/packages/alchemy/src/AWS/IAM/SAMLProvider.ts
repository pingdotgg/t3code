import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AWSEnvironment } from "../Environment.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
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
    samlProviderArn: string;
    name: string;
    samlProviderUUID: string | undefined;
    samlMetadataDocument: string | undefined;
    assertionEncryptionMode: iam.AssertionEncryptionModeType | undefined;
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
 *
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
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const internalTags = yield* createInternalTags(id);
      const desiredTags = {
        ...internalTags,
        ...news.tags,
      };
      const accountId = (yield* AWSEnvironment).accountId;
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
          yield* iam.updateSAMLProvider({
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
          });
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
