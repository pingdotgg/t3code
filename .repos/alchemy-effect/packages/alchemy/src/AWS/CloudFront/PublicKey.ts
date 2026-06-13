import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { extractValue } from "./common.ts";

export interface PublicKeyProps {
  /**
   * Name of the public key. If omitted, a deterministic name is generated.
   *
   * Names must be unique per AWS account. Changing the name triggers
   * a replacement.
   */
  name?: string;
  /**
   * PEM-encoded public key body. Changing the key material triggers a
   * replacement (CloudFront does not allow rotating an existing public
   * key in place).
   */
  encodedKey: Redacted.Redacted<string> | string;
  /**
   * Optional comment describing the key.
   */
  comment?: string;
}

export interface PublicKey extends Resource<
  "AWS.CloudFront.PublicKey",
  PublicKeyProps,
  {
    /**
     * CloudFront-assigned public key identifier. Used by KeyGroups to
     * reference the key.
     */
    publicKeyId: string;
    /**
     * Name of the public key.
     */
    name: string;
    /**
     * PEM-encoded public key body.
     */
    encodedKey: string;
    /**
     * Caller reference used at create time. Stable across updates.
     */
    callerReference: string;
    /**
     * Most recent entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Current comment on the key.
     */
    comment: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudFront public key.
 *
 * Public keys are uploaded ahead of being grouped into a {@link KeyGroup} and
 * used by Distributions for signed URL or signed cookie verification.
 *
 * The key body is immutable after creation — changing `encodedKey` triggers
 * a replacement (CloudFront returns no API to rotate a key in place).
 *
 * @section Creating Public Keys
 * @example PEM-encoded RSA public key
 * ```typescript
 * const key = yield* PublicKey("SignedUrlKey", {
 *   encodedKey: Redacted.make(yield* fs.readFileString("./public_key.pem")),
 *   comment: "RSA-2048 signed URL key for /private",
 * });
 * ```
 */
export const PublicKey = Resource<PublicKey>("AWS.CloudFront.PublicKey");

export const PublicKeyProvider = () =>
  Provider.effect(
    PublicKey,
    Effect.gen(function* () {
      const getById = Effect.fn(function* (id: string) {
        const config = yield* cloudfront
          .getPublicKeyConfig({ Id: id })
          .pipe(
            Effect.catchTag("NoSuchPublicKey", () => Effect.succeed(undefined)),
          );
        if (!config?.PublicKeyConfig) return undefined;
        return { config: config.PublicKeyConfig, etag: config.ETag };
      });

      const getByName = Effect.fn(function* (name: string) {
        const listed = yield* cloudfront.listPublicKeys({});
        const summary = listed.PublicKeyList?.Items?.find(
          (item) => item.Name === name,
        );
        if (!summary?.Id) return undefined;
        return yield* getById(summary.Id).pipe(
          Effect.map((found) =>
            found ? { id: summary.Id, ...found } : undefined,
          ),
        );
      });

      const buildConfig = (
        name: string,
        callerReference: string,
        props: PublicKeyProps,
      ): cloudfront.PublicKeyConfig => ({
        Name: name,
        CallerReference: callerReference,
        EncodedKey: extractValue(props.encodedKey),
        Comment: props.comment,
      });

      const toAttrs = (
        id: string,
        config: cloudfront.PublicKeyConfig,
        etag: string | undefined,
      ) => ({
        publicKeyId: id,
        name: config.Name,
        encodedKey: config.EncodedKey,
        callerReference: config.CallerReference,
        etag,
        comment: config.Comment,
      });

      return {
        stables: ["publicKeyId", "callerReference"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* createName(id, olds ?? {})) !==
            (yield* createName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(olds.encodedKey) &&
            extractValue(olds.encodedKey) !== extractValue(news.encodedKey)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.publicKeyId) {
            const found = yield* getById(output.publicKeyId);
            if (found)
              return toAttrs(output.publicKeyId, found.config, found.etag);
          }
          const name = yield* createName(id, olds ?? {});
          const found = yield* getByName(name);
          if (!found) return undefined;
          return toAttrs(found.id, found.config, found.etag);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);

          // Observe — locate the public key by id (cached on `output`)
          // or by name. Trust observed cloud state, not stale `olds`.
          let observed = output?.publicKeyId
            ? yield* getById(output.publicKeyId).pipe(
                Effect.map((found) =>
                  found ? { id: output.publicKeyId, ...found } : undefined,
                ),
              )
            : undefined;
          if (!observed) {
            observed = yield* getByName(name);
          }

          // Ensure — create the public key if it's missing. Tolerate
          // `PublicKeyAlreadyExists` (race with a peer reconciler).
          if (!observed) {
            const callerReference = name;
            const created = yield* cloudfront
              .createPublicKey({
                PublicKeyConfig: buildConfig(name, callerReference, news),
              })
              .pipe(
                Effect.catchTag("PublicKeyAlreadyExists", () =>
                  getByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed({
                            PublicKey: {
                              Id: existing.id,
                              CreatedTime: new Date(),
                              PublicKeyConfig: existing.config,
                            },
                            ETag: existing.etag,
                            Location: undefined,
                          })
                        : Effect.fail(
                            new Error(
                              `Public key '${name}' already exists but could not be recovered`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            if (!created.PublicKey?.Id) {
              return yield* Effect.fail(
                new Error("createPublicKey returned no identifier"),
              );
            }
            yield* session.note(created.PublicKey.Id);
            return toAttrs(
              created.PublicKey.Id,
              created.PublicKey.PublicKeyConfig,
              created.ETag,
            );
          }

          // Sync — patch the comment via `updatePublicKey`. The key body
          // is immutable (replacement is forced in `diff`), and the
          // CallerReference is observed from the live config rather than
          // re-derived. The freshly observed ETag handles optimistic
          // concurrency.
          const updated = yield* cloudfront.updatePublicKey({
            Id: observed.id,
            IfMatch: observed.etag,
            PublicKeyConfig: buildConfig(
              observed.config.Name,
              observed.config.CallerReference,
              news,
            ),
          });
          if (!updated.PublicKey?.Id) {
            return yield* Effect.fail(
              new Error("updatePublicKey returned no identifier"),
            );
          }
          yield* session.note(observed.id);
          return toAttrs(
            updated.PublicKey.Id,
            updated.PublicKey.PublicKeyConfig,
            updated.ETag,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const current = yield* getById(output.publicKeyId);
          if (!current) return;
          yield* cloudfront
            .deletePublicKey({
              Id: output.publicKeyId,
              IfMatch: current.etag,
            })
            .pipe(Effect.catchTag("NoSuchPublicKey", () => Effect.void));
        }),
      };
    }),
  );

const createName = (id: string, props: PublicKeyProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 128, lowercase: true });
