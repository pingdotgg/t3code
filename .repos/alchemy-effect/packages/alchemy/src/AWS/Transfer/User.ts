import * as transfer from "@distilled.cloud/aws/transfer";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface UserProps {
  /**
   * ID of the Transfer Family server the user belongs to (e.g.
   * `server.serverId`). Changing it replaces the user.
   */
  serverId: string;
  /**
   * User name clients authenticate as. Must be 3-100 characters. Changing it
   * replaces the user.
   */
  userName: string;
  /**
   * IAM role ARN granting the user access to the storage backend (S3/EFS).
   */
  role: string;
  /**
   * Landing directory when the user connects (PATH mode).
   */
  homeDirectory?: string;
  /**
   * Whether the user sees the absolute bucket path (`PATH`) or a virtual
   * chroot built from `homeDirectoryMappings` (`LOGICAL`).
   * @default "PATH"
   */
  homeDirectoryType?: transfer.HomeDirectoryType;
  /**
   * Virtual-to-actual path mappings for `LOGICAL` home-directory mode.
   */
  homeDirectoryMappings?: transfer.HomeDirectoryMapEntry[];
  /**
   * Inline session policy scoping the user's access, as a JSON string.
   */
  policy?: string;
  /**
   * POSIX identity (uid/gid) applied to the user, required for EFS servers.
   */
  posixProfile?: transfer.PosixProfile;
  /**
   * SSH public key body to register for the user at creation (service-managed
   * identity provider). Additional keys can be managed out of band.
   */
  sshPublicKeyBody?: string;
  /**
   * User-defined tags for the user.
   */
  tags?: Record<string, string>;
}

export interface User extends Resource<
  "AWS.Transfer.User",
  UserProps,
  {
    /**
     * User name clients authenticate as.
     */
    userName: string;
    /**
     * ID of the Transfer Family server the user belongs to.
     */
    serverId: string;
    /**
     * ARN of the user.
     */
    arn: string;
    /**
     * IAM role ARN granting the user access to the storage backend.
     */
    role: string | undefined;
    /**
     * Landing directory when the user connects.
     */
    homeDirectory: string | undefined;
    /**
     * Current tags reported for the user.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A user of an AWS Transfer Family server (service-managed identity
 * provider). Users are free configuration objects attached to a
 * {@link Server}; the server itself is what incurs hourly cost.
 * @resource
 * @section Creating a User
 * @example Service-Managed SFTP User
 * ```typescript
 * const user = yield* User("Alice", {
 *   serverId: server.serverId,
 *   userName: "alice",
 *   role: transferRole.roleArn,
 *   homeDirectory: "/my-bucket/alice",
 *   sshPublicKeyBody: "ssh-ed25519 AAAA...",
 * });
 * ```
 */
export const User = Resource<User>("AWS.Transfer.User");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const UserProvider = () =>
  Provider.effect(
    User,
    Effect.gen(function* () {
      const describe = Effect.fn(function* (
        serverId: string,
        userName: string,
      ) {
        const response = yield* transfer
          .describeUser({ ServerId: serverId, UserName: userName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.User;
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* transfer
          .listTagsForResource({ Arn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.Tags);
      });

      const toAttrs = Effect.fn(function* (
        serverId: string,
        user: transfer.DescribedUser,
      ) {
        if (!user.UserName) {
          return yield* Effect.fail(
            new Error("Transfer user is missing its UserName"),
          );
        }
        return {
          userName: user.UserName,
          serverId,
          arn: user.Arn,
          role: user.Role,
          homeDirectory: user.HomeDirectory,
          tags: yield* readTags(user.Arn),
        };
      });

      return {
        stables: ["userName", "serverId", "arn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // ServerId and UserName are the resource identity.
          if (
            news.serverId !== olds?.serverId ||
            news.userName !== olds?.userName
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const serverId = output?.serverId ?? olds?.serverId;
          const userName = output?.userName ?? olds?.userName;
          if (!serverId || !userName) return undefined;
          const user = yield* describe(serverId, userName);
          if (!user?.UserName) return undefined;
          const attrs = yield* toAttrs(serverId, user);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* describe(news.serverId, news.userName);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* transfer
              .createUser({
                ServerId: news.serverId,
                UserName: news.userName,
                Role: news.role,
                HomeDirectory: news.homeDirectory,
                HomeDirectoryType: news.homeDirectoryType,
                HomeDirectoryMappings: news.homeDirectoryMappings,
                Policy: news.policy,
                PosixProfile: news.posixProfile,
                SshPublicKeyBody: news.sshPublicKeyBody,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("ResourceExistsException", () => Effect.void),
              );
          } else {
            // 3. Sync — push mutable configuration.
            yield* transfer.updateUser({
              ServerId: news.serverId,
              UserName: news.userName,
              Role: news.role,
              HomeDirectory: news.homeDirectory,
              HomeDirectoryType: news.homeDirectoryType,
              HomeDirectoryMappings: news.homeDirectoryMappings,
              Policy: news.policy,
              PosixProfile: news.posixProfile,
            });
          }

          observed = yield* describe(news.serverId, news.userName);
          if (!observed?.UserName) {
            return yield* Effect.fail(
              new Error(
                `Transfer user '${news.userName}' not found after reconcile`,
              ),
            );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.Arn;
          const observedTags = yield* readTags(arn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* transfer.tagResource({ Arn: arn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* transfer.untagResource({ Arn: arn, TagKeys: removed });
          }

          yield* session.note(`${news.serverId}/${news.userName}`);
          return yield* toAttrs(news.serverId, observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* transfer
            .deleteUser({
              ServerId: output.serverId,
              UserName: output.userName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Users are sub-resources keyed by their parent server; there is no
        // account-wide enumeration without a server id.
        list: () => Effect.succeed([]),
      };
    }),
  );
