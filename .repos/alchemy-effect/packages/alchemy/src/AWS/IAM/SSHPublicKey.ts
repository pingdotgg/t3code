import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface SSHPublicKeyProps {
  /**
   * User that owns the SSH public key.
   */
  userName: string;
  /**
   * SSH public key body.
   */
  sshPublicKeyBody: string;
  /**
   * Desired key status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface SSHPublicKey extends Resource<
  "AWS.IAM.SSHPublicKey",
  SSHPublicKeyProps,
  {
    /** The IAM user the SSH public key belongs to. */
    userName: string;
    /** The unique ID of the SSH public key. */
    sshPublicKeyId: string;
    /** The MD5 fingerprint of the SSH public key. */
    fingerprint: string;
    /** The SSH public key material. */
    sshPublicKeyBody: string;
    /** Whether the key is `Active` or `Inactive`. */
    status: iam.StatusType;
    /** When the key was uploaded. */
    uploadDate: Date | undefined;
  },
  never,
  Providers
> {}

/**
 * An IAM SSH public key for CodeCommit-compatible workflows.
 *
 * `SSHPublicKey` uploads and manages a user's public key for services such as
 * AWS CodeCommit that authenticate through IAM-backed SSH credentials.
 * @resource
 * @section Managing SSH Keys
 * @example Upload an SSH Public Key
 * ```typescript
 * const user = yield* User("GitUser", {
 *   userName: "codecommit-user",
 * });
 *
 * const key = yield* SSHPublicKey("GitKey", {
 *   userName: user.userName,
 *   sshPublicKeyBody: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample codecommit-user",
 * });
 * ```
 */
export const SSHPublicKey = Resource<SSHPublicKey>("AWS.IAM.SSHPublicKey");

export const SSHPublicKeyProvider = () =>
  Provider.succeed(SSHPublicKey, {
    stables: ["sshPublicKeyId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.userName !== news.userName ||
        olds.sshPublicKeyBody !== news.sshPublicKeyBody
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getSSHPublicKey({
          UserName: output.userName,
          SSHPublicKeyId: output.sshPublicKeyId,
          Encoding: "SSH",
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response?.SSHPublicKey?.SSHPublicKeyId) {
        return undefined;
      }
      return {
        userName: response.SSHPublicKey.UserName,
        sshPublicKeyId: response.SSHPublicKey.SSHPublicKeyId,
        fingerprint: response.SSHPublicKey.Fingerprint,
        sshPublicKeyBody: response.SSHPublicKey.SSHPublicKeyBody,
        status: response.SSHPublicKey.Status,
        uploadDate: response.SSHPublicKey.UploadDate,
      };
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      // Observe — SSH key ids are AWS-generated; we can only locate the
      // existing key when we have its id from a prior output. The body
      // and identity are immutable (`diff` triggers replacement on body
      // change), so a missing key always means we need to upload.
      const observed = output
        ? yield* iam
            .getSSHPublicKey({
              UserName: output.userName,
              SSHPublicKeyId: output.sshPublicKeyId,
              Encoding: "SSH",
            })
            .pipe(
              Effect.map((r) => r.SSHPublicKey),
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            )
        : undefined;

      // Ensure — upload when missing.
      let key = observed;
      if (!key?.SSHPublicKeyId) {
        const uploaded = yield* iam.uploadSSHPublicKey({
          UserName: news.userName,
          SSHPublicKeyBody: news.sshPublicKeyBody,
        });
        if (!uploaded.SSHPublicKey?.SSHPublicKeyId) {
          return yield* Effect.fail(
            new Error(`uploadSSHPublicKey returned no key id`),
          );
        }
        key = uploaded.SSHPublicKey;
      }

      // Sync — apply the desired status when it differs from observed.
      const desiredStatus = news.status ?? key.Status;
      if (desiredStatus !== key.Status) {
        yield* iam.updateSSHPublicKey({
          UserName: news.userName,
          SSHPublicKeyId: key.SSHPublicKeyId!,
          Status: desiredStatus,
        });
      }

      yield* session.note(key.SSHPublicKeyId!);
      return {
        userName: key.UserName,
        sshPublicKeyId: key.SSHPublicKeyId!,
        fingerprint: key.Fingerprint,
        sshPublicKeyBody: key.SSHPublicKeyBody,
        status: desiredStatus,
        uploadDate: key.UploadDate,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSSHPublicKey({
          UserName: output.userName,
          SSHPublicKeyId: output.sshPublicKeyId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
    // IAM is a global service. `listSSHPublicKeys` requires a `UserName`, so we
    // enumerate every IAM user first (paginated) and then list each user's keys
    // (also paginated) with bounded concurrency. The list metadata omits the
    // fingerprint and key body, so each key is hydrated with `getSSHPublicKey`
    // to produce the full `Attributes` shape that `read` returns.
    list: Effect.fn(function* () {
      const users = yield* iam.listUsers.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.Users)),
      );
      const perUser = yield* Effect.forEach(
        users,
        (user) =>
          iam.listSSHPublicKeys.pages({ UserName: user.UserName }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.SSHPublicKeys ?? []),
            ),
            Effect.flatMap((metas) =>
              Effect.forEach(
                metas,
                (meta) =>
                  iam
                    .getSSHPublicKey({
                      UserName: meta.UserName,
                      SSHPublicKeyId: meta.SSHPublicKeyId,
                      Encoding: "SSH",
                    })
                    .pipe(
                      Effect.map((r) => r.SSHPublicKey),
                      // The key may be deleted between enumeration and
                      // hydration.
                      Effect.catchTag("NoSuchEntityException", () =>
                        Effect.succeed(undefined),
                      ),
                    ),
                { concurrency: 10 },
              ),
            ),
            Effect.map((keys) =>
              keys
                .filter(
                  (key): key is iam.SSHPublicKey => key?.SSHPublicKeyId != null,
                )
                .map((key) => ({
                  userName: key.UserName,
                  sshPublicKeyId: key.SSHPublicKeyId,
                  fingerprint: key.Fingerprint,
                  sshPublicKeyBody: key.SSHPublicKeyBody,
                  status: key.Status,
                  uploadDate: key.UploadDate,
                })),
            ),
            // The user may be deleted between enumeration and per-user list.
            Effect.catchTag("NoSuchEntityException", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perUser.flat();
    }),
  });
