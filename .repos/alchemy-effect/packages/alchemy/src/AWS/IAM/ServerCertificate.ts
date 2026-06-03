import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import { toTagRecord } from "./common.ts";

export interface ServerCertificateProps {
  /**
   * Name of the server certificate. If omitted, a deterministic name is generated.
   */
  serverCertificateName?: string;
  /**
   * Optional IAM path prefix.
   * @default "/"
   */
  path?: string;
  /**
   * PEM-encoded leaf certificate body.
   */
  certificateBody: string;
  /**
   * PEM-encoded private key. AWS never returns this after upload.
   */
  privateKey: Redacted.Redacted<string> | string;
  /**
   * Optional PEM-encoded certificate chain.
   */
  certificateChain?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface ServerCertificate extends Resource<
  "AWS.IAM.ServerCertificate",
  ServerCertificateProps,
  {
    serverCertificateArn: string;
    serverCertificateName: string;
    serverCertificateId: string | undefined;
    path: string | undefined;
    certificateBody: string;
    certificateChain: string | undefined;
    uploadDate: Date | undefined;
    expiration: Date | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM server certificate.
 *
 * `ServerCertificate` uploads and tracks a TLS certificate bundle for legacy
 * IAM-integrated services. The private key is write-only and should be provided
 * as a redacted value when possible.
 *
 * @section Uploading Server Certificates
 * @example Upload a TLS Certificate
 * ```typescript
 * const certificate = yield* ServerCertificate("ApiTlsCertificate", {
 *   certificateBody: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
 *   privateKey: Redacted.make(
 *     "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
 *   ),
 *   certificateChain: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
 * });
 * ```
 */
export const ServerCertificate = Resource<ServerCertificate>(
  "AWS.IAM.ServerCertificate",
);

export const ServerCertificateProvider = () =>
  Provider.effect(
    ServerCertificate,
    Effect.gen(function* () {
      const toName = (id: string, props: ServerCertificateProps) =>
        props.serverCertificateName
          ? Effect.succeed(props.serverCertificateName)
          : createPhysicalName({ id, maxLength: 128 });

      const readCertificate = Effect.fn(function* (name: string) {
        const response = yield* iam
          .getServerCertificate({
            ServerCertificateName: name,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ServerCertificate;
      });

      return {
        stables: [
          "serverCertificateArn",
          "serverCertificateName",
          "serverCertificateId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? ({} as ServerCertificateProps))) !==
              (yield* toName(id, news)) ||
            (olds.path ?? "/") !== (news.path ?? "/") ||
            olds.certificateBody !== news.certificateBody ||
            olds.certificateChain !== news.certificateChain
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.serverCertificateName ??
            (yield* toName(id, olds ?? ({} as ServerCertificateProps)));
          const cert = yield* readCertificate(name);
          if (!cert?.ServerCertificateMetadata?.Arn) {
            return undefined;
          }
          const tags = yield* iam.listServerCertificateTags({
            ServerCertificateName: name,
          });
          return {
            serverCertificateArn: cert.ServerCertificateMetadata.Arn,
            serverCertificateName:
              cert.ServerCertificateMetadata.ServerCertificateName,
            serverCertificateId:
              cert.ServerCertificateMetadata.ServerCertificateId,
            path: cert.ServerCertificateMetadata.Path,
            certificateBody: cert.CertificateBody,
            certificateChain: cert.CertificateChain,
            uploadDate: cert.ServerCertificateMetadata.UploadDate,
            expiration: cert.ServerCertificateMetadata.Expiration,
            tags: toTagRecord(tags.Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.serverCertificateName ?? (yield* toName(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — `getServerCertificate` returns the live cert (or
          // absence). The cert body / chain are immutable (`diff`
          // triggers replacement), so we never re-upload during sync.
          let cert = yield* readCertificate(name);

          // Ensure — upload when missing. On race, verify alchemy
          // ownership tags; bail out otherwise.
          if (!cert?.ServerCertificateMetadata?.Arn) {
            const created = yield* iam
              .uploadServerCertificate({
                Path: news.path,
                ServerCertificateName: name,
                CertificateBody: news.certificateBody,
                PrivateKey:
                  typeof news.privateKey === "string"
                    ? news.privateKey
                    : Redacted.value(news.privateKey),
                CertificateChain: news.certificateChain,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  Effect.gen(function* () {
                    const existing = yield* readCertificate(name);
                    if (!existing?.ServerCertificateMetadata?.Arn) {
                      return yield* Effect.fail(
                        new Error(
                          `Server certificate '${name}' already exists but could not be described`,
                        ),
                      );
                    }
                    if (!hasTags(desiredTags, existing.Tags)) {
                      return yield* Effect.fail(
                        new Error(
                          `Server certificate '${name}' already exists and is not managed by alchemy`,
                        ),
                      );
                    }
                    return {
                      ServerCertificateMetadata:
                        existing.ServerCertificateMetadata,
                    };
                  }),
                ),
              );
            if (!created.ServerCertificateMetadata?.Arn) {
              return yield* Effect.fail(
                new Error(`uploadServerCertificate returned no metadata`),
              );
            }
            cert = yield* readCertificate(name);
          }

          // Sync tags against the cloud's actual tags.
          const observedTags = toTagRecord(cert?.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagServerCertificate({
              ServerCertificateName: name,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagServerCertificate({
              ServerCertificateName: name,
              TagKeys: removed,
            });
          }

          // Re-read for fresh metadata.
          const fresh = yield* readCertificate(name);
          const metadata = fresh?.ServerCertificateMetadata;
          if (!metadata?.Arn || !metadata.ServerCertificateName) {
            return yield* Effect.fail(
              new Error(
                `Server certificate '${name}' was not readable after sync`,
              ),
            );
          }

          yield* session.note(metadata.Arn);
          return {
            serverCertificateArn: metadata.Arn,
            serverCertificateName: metadata.ServerCertificateName,
            serverCertificateId: metadata.ServerCertificateId,
            path: metadata.Path,
            certificateBody: fresh?.CertificateBody ?? news.certificateBody,
            certificateChain: fresh?.CertificateChain ?? news.certificateChain,
            uploadDate: metadata.UploadDate,
            expiration: metadata.Expiration,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .deleteServerCertificate({
              ServerCertificateName: output.serverCertificateName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
