import * as transfer from "@distilled.cloud/aws/transfer";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ServerProps {
  /**
   * File-transfer protocols the server exposes.
   * @default ["SFTP"]
   */
  protocols?: transfer.Protocol[];
  /**
   * Storage domain the server serves files from. Changing it replaces the
   * server.
   * @default "S3"
   */
  domain?: transfer.Domain;
  /**
   * Where the server endpoint is hosted. `PUBLIC` is internet-facing;
   * `VPC` places it inside a VPC (requires `endpointDetails`).
   * @default "PUBLIC"
   */
  endpointType?: transfer.EndpointType;
  /**
   * VPC endpoint configuration (subnets, security groups, address
   * allocations). Required when `endpointType` is `VPC`.
   */
  endpointDetails?: transfer.EndpointDetails;
  /**
   * How users authenticate. `SERVICE_MANAGED` stores SSH keys in Transfer
   * Family; `API_GATEWAY`/`AWS_LAMBDA`/`AWS_DIRECTORY_SERVICE` delegate to a
   * custom identity provider. Changing it replaces the server.
   * @default "SERVICE_MANAGED"
   */
  identityProviderType?: transfer.IdentityProviderType;
  /**
   * Configuration for a custom identity provider (required unless
   * `identityProviderType` is `SERVICE_MANAGED`).
   */
  identityProviderDetails?: transfer.IdentityProviderDetails;
  /**
   * IAM role ARN Transfer Family assumes to publish CloudWatch logs.
   */
  loggingRole?: string;
  /**
   * Name of the security policy (cipher/algorithm set) attached to the server.
   */
  securityPolicyName?: string;
  /**
   * Banner shown to clients before authentication (SFTP/FTPS only).
   */
  preAuthenticationLoginBanner?: string;
  /**
   * Banner shown to clients after authentication.
   */
  postAuthenticationLoginBanner?: string;
  /**
   * Protocol-specific settings (passive IP, TLS session resumption, etc.).
   */
  protocolDetails?: transfer.ProtocolDetails;
  /**
   * S3 storage options such as directory-listing optimization.
   */
  s3StorageOptions?: transfer.S3StorageOptions;
  /**
   * Workflows triggered on file upload.
   */
  workflowDetails?: transfer.WorkflowDetails;
  /**
   * CloudWatch Logs log-group ARNs the server streams structured logs to.
   */
  structuredLogDestinations?: string[];
  /**
   * IP address type of the endpoint.
   * @default "IPV4"
   */
  ipAddressType?: transfer.IpAddressType;
  /**
   * User-defined tags for the server.
   */
  tags?: Record<string, string>;
}

export interface Server extends Resource<
  "AWS.Transfer.Server",
  ServerProps,
  {
    /**
     * AWS-assigned server ID (e.g. `s-0123456789abcdef0`). Clients connect to
     * `{serverId}.server.transfer.{region}.amazonaws.com`.
     */
    serverId: string;
    /**
     * ARN of the server.
     */
    arn: string;
    /**
     * Where the server endpoint is hosted (`PUBLIC` or `VPC`).
     */
    endpointType: string;
    /**
     * Storage domain the server serves files from (`S3` or `EFS`).
     */
    domain: string;
    /**
     * How users authenticate.
     */
    identityProviderType: string;
    /**
     * File-transfer protocols the server exposes.
     */
    protocols: string[];
    /**
     * Current lifecycle state (e.g. `ONLINE`, `STARTING`).
     */
    state: string | undefined;
    /**
     * Current tags reported for the server.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Transfer Family server — a managed SFTP/FTPS/FTP/AS2 endpoint in
 * front of S3 or EFS storage. A running server is billed hourly (plus data
 * transfer), so create it only when needed and destroy it promptly.
 * @resource
 * @section Creating a Server
 * @example Public SFTP Server (Service-Managed Users)
 * ```typescript
 * const server = yield* Server("Sftp", {
 *   protocols: ["SFTP"],
 *   domain: "S3",
 *   endpointType: "PUBLIC",
 *   identityProviderType: "SERVICE_MANAGED",
 * });
 * ```
 *
 * @section Adding Users
 * @example SFTP Server with a Service-Managed User
 * ```typescript
 * const server = yield* Server("Sftp", {
 *   protocols: ["SFTP"],
 *   identityProviderType: "SERVICE_MANAGED",
 * });
 *
 * // Role Transfer Family assumes to access the S3 storage backend
 * const role = yield* AWS.IAM.Role("TransferUserRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "transfer.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 *   inlinePolicies: {
 *     s3: {
 *       Version: "2012-10-17",
 *       Statement: [
 *         {
 *           Effect: "Allow",
 *           Action: ["s3:ListBucket", "s3:GetObject", "s3:PutObject"],
 *           Resource: [bucket.bucketArn, Output.interpolate`${bucket.bucketArn}/*`],
 *         },
 *       ],
 *     },
 *   },
 * });
 *
 * const user = yield* User("Alice", {
 *   serverId: server.serverId,
 *   userName: "alice",
 *   role: role.roleArn,
 *   homeDirectory: Output.interpolate`/${bucket.bucketName}/alice`,
 *   sshPublicKeyBody: "ssh-ed25519 AAAA...",
 * });
 * ```
 */
export const Server = Resource<Server>("AWS.Transfer.Server");

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

export const ServerProvider = () =>
  Provider.effect(
    Server,
    Effect.gen(function* () {
      const describe = Effect.fn(function* (serverId: string) {
        const response = yield* transfer
          .describeServer({ ServerId: serverId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Server;
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* transfer
          .listTagsForResource({ Arn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.Tags);
      });

      // Servers transition through STARTING before ONLINE; updateServer and
      // deleteServer require a settled state. Budget ~7 minutes (10s x 42).
      const waitUntilSettled = Effect.fn(function* (serverId: string) {
        const settlePolicy = Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(42),
        ]);
        return yield* describe(serverId).pipe(
          Effect.flatMap((server) => {
            if (
              server !== undefined &&
              (server.State === "STARTING" || server.State === "STOPPING")
            ) {
              return Effect.fail(
                new Error(
                  `Transfer server '${serverId}' still settling (state: ${server.State})`,
                ),
              );
            }
            return Effect.succeed(server);
          }),
          Effect.retry({ schedule: settlePolicy }),
        );
      });

      const toAttrs = Effect.fn(function* (server: transfer.DescribedServer) {
        if (!server.ServerId) {
          return yield* Effect.fail(
            new Error("Transfer server is missing its ServerId"),
          );
        }
        return {
          serverId: server.ServerId,
          arn: server.Arn,
          endpointType: server.EndpointType ?? "PUBLIC",
          domain: server.Domain ?? "S3",
          identityProviderType:
            server.IdentityProviderType ?? "SERVICE_MANAGED",
          protocols: [...(server.Protocols ?? [])],
          state: server.State,
          tags: yield* readTags(server.Arn),
        };
      });

      return {
        stables: ["serverId", "arn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Domain and identity-provider type are create-only.
          if (
            (news.domain ?? "S3") !== (olds?.domain ?? "S3") ||
            (news.identityProviderType ?? "SERVICE_MANAGED") !==
              (olds?.identityProviderType ?? "SERVICE_MANAGED")
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          // ServerId is AWS-assigned, so a server can only be found via a
          // previously-persisted output (like an auto-id VPC).
          if (!output?.serverId) return undefined;
          const server = yield* describe(output.serverId);
          if (!server?.ServerId) return undefined;
          const attrs = yield* toAttrs(server);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative (via the id cache).
          let serverId = output?.serverId;
          let observed = serverId ? yield* describe(serverId) : undefined;

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            const created = yield* transfer.createServer({
              Protocols: news.protocols ?? ["SFTP"],
              Domain: news.domain,
              EndpointType: news.endpointType,
              EndpointDetails: news.endpointDetails,
              IdentityProviderType: news.identityProviderType,
              IdentityProviderDetails: news.identityProviderDetails,
              LoggingRole: news.loggingRole,
              SecurityPolicyName: news.securityPolicyName,
              PreAuthenticationLoginBanner: news.preAuthenticationLoginBanner,
              PostAuthenticationLoginBanner: news.postAuthenticationLoginBanner,
              ProtocolDetails: news.protocolDetails,
              S3StorageOptions: news.s3StorageOptions,
              WorkflowDetails: news.workflowDetails,
              StructuredLogDestinations: news.structuredLogDestinations,
              IpAddressType: news.ipAddressType,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            serverId = created.ServerId;
          } else {
            // 3. Sync — push mutable configuration. updateServer requires a
            //    settled server state.
            yield* waitUntilSettled(serverId!);
            yield* transfer.updateServer({
              ServerId: serverId!,
              Protocols: news.protocols,
              EndpointType: news.endpointType,
              EndpointDetails: news.endpointDetails,
              IdentityProviderDetails: news.identityProviderDetails,
              LoggingRole: news.loggingRole,
              SecurityPolicyName: news.securityPolicyName,
              PreAuthenticationLoginBanner: news.preAuthenticationLoginBanner,
              PostAuthenticationLoginBanner: news.postAuthenticationLoginBanner,
              ProtocolDetails: news.protocolDetails,
              S3StorageOptions: news.s3StorageOptions,
              WorkflowDetails: news.workflowDetails,
              StructuredLogDestinations: news.structuredLogDestinations,
              IpAddressType: news.ipAddressType,
            });
          }

          // Wait for the server to settle so downstream User creation and the
          // returned state are stable.
          observed = yield* waitUntilSettled(serverId!);
          if (!observed?.ServerId || !observed.Arn) {
            return yield* Effect.fail(
              new Error(
                `Transfer server '${serverId}' not found after reconcile`,
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

          yield* session.note(observed.ServerId);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* transfer
            .deleteServer({ ServerId: output.serverId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          transfer.listServers.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Servers ?? []).filter(
                  (server) => server.ServerId !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach(
                (server) =>
                  toAttrs({
                    Arn: server.Arn,
                    ServerId: server.ServerId,
                    Domain: server.Domain,
                    EndpointType: server.EndpointType,
                    IdentityProviderType: server.IdentityProviderType,
                    State: server.State,
                    LoggingRole: server.LoggingRole,
                  }),
                { concurrency: 4 },
              ),
            ),
          ),
      };
    }),
  );
