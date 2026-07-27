import * as ds from "@distilled.cloud/aws/directory-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameStringSet } from "./internal.ts";

export interface ConditionalForwarderProps {
  /**
   * Id of the {@link Directory} (AWS Managed Microsoft AD or AD Connector)
   * the conditional forwarder is configured on. Simple AD does not support
   * conditional forwarders. Changing the directory replaces the forwarder.
   */
  directoryId: string;
  /**
   * Fully qualified domain name of the remote domain DNS queries are
   * forwarded to, e.g. `partner.example.com`. Changing the domain replaces
   * the forwarder.
   */
  remoteDomainName: string;
  /**
   * IP addresses of the remote domain's DNS servers. Updated in place.
   */
  dnsIpAddrs: string[];
}

export interface ConditionalForwarder extends Resource<
  "AWS.DirectoryService.ConditionalForwarder",
  ConditionalForwarderProps,
  {
    /** The ID of the directory the forwarder is attached to. */
    directoryId: string;
    /** The fully qualified domain name the forwarder resolves. */
    remoteDomainName: string;
    /** The IP addresses of the remote DNS servers. */
    dnsIpAddrs: string[];
    /** The replication scope of the forwarder, e.g. `Domain`. */
    replicationScope: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A conditional forwarder on an AWS Managed Microsoft AD (or AD Connector)
 * directory — forwards DNS queries for a remote domain to that domain's DNS
 * servers. Conditional forwarders are the prerequisite for trust
 * relationships with other domains.
 * @resource
 * @section Creating a Conditional Forwarder
 * @example Forward a Partner Domain
 * ```typescript
 * const directory = yield* Directory("Corp", {
 *   type: "MicrosoftAD",
 *   name: "corp.example.com",
 *   password: Redacted.make("SuperSecret123!"),
 *   vpcId: vpc.vpcId,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * const forwarder = yield* ConditionalForwarder("Partner", {
 *   directoryId: directory.directoryId,
 *   remoteDomainName: "partner.example.com",
 *   dnsIpAddrs: ["10.10.0.2", "10.10.1.2"],
 * });
 * ```
 */
export const ConditionalForwarder = Resource<ConditionalForwarder>(
  "AWS.DirectoryService.ConditionalForwarder",
);

// The directory transiently rejects forwarder mutations while its domain
// controllers are busy (DirectoryUnavailableException); bounded retry
// through that window.
const retryWhileDirectoryUnavailable = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "DirectoryUnavailableException",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(8)]),
  });

export const ConditionalForwarderProvider = () =>
  Provider.effect(
    ConditionalForwarder,
    Effect.gen(function* () {
      const readForwarder = Effect.fn(function* (
        directoryId: string,
        remoteDomainName: string,
      ) {
        const response = yield* ds
          .describeConditionalForwarders({
            DirectoryId: directoryId,
            RemoteDomainNames: [remoteDomainName],
          })
          .pipe(
            Effect.catchTag("EntityDoesNotExistException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ConditionalForwarders?.find(
          (forwarder) => forwarder.RemoteDomainName === remoteDomainName,
        );
      });

      const toAttrs = (
        directoryId: string,
        remoteDomainName: string,
        forwarder: ds.ConditionalForwarder,
      ) => ({
        directoryId,
        remoteDomainName,
        dnsIpAddrs: [...(forwarder.DnsIpAddrs ?? [])],
        replicationScope: forwarder.ReplicationScope,
      });

      return {
        stables: ["directoryId", "remoteDomainName"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined || news === undefined) return undefined;
          if (news.directoryId !== olds.directoryId) {
            return { action: "replace" } as const;
          }
          if (news.remoteDomainName !== olds.remoteDomainName) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const directoryId = output?.directoryId ?? olds?.directoryId;
          const remoteDomainName =
            output?.remoteDomainName ?? olds?.remoteDomainName;
          if (directoryId === undefined || remoteDomainName === undefined) {
            return undefined;
          }
          const forwarder = yield* readForwarder(directoryId, remoteDomainName);
          if (forwarder === undefined) return undefined;
          return toAttrs(directoryId, remoteDomainName, forwarder);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const props = news!;

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readForwarder(
            props.directoryId,
            props.remoteDomainName,
          );

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* ds
              .createConditionalForwarder({
                DirectoryId: props.directoryId,
                RemoteDomainName: props.remoteDomainName,
                DnsIpAddrs: props.dnsIpAddrs,
              })
              .pipe(
                retryWhileDirectoryUnavailable,
                Effect.catchTag(
                  "EntityAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            observed = yield* readForwarder(
              props.directoryId,
              props.remoteDomainName,
            );
          }

          // 3. Sync — update the DNS addresses only when observed state
          //    differs from desired.
          if (!sameStringSet(observed?.DnsIpAddrs, props.dnsIpAddrs)) {
            yield* ds
              .updateConditionalForwarder({
                DirectoryId: props.directoryId,
                RemoteDomainName: props.remoteDomainName,
                DnsIpAddrs: props.dnsIpAddrs,
              })
              .pipe(retryWhileDirectoryUnavailable);
            observed = yield* readForwarder(
              props.directoryId,
              props.remoteDomainName,
            );
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `conditional forwarder for '${props.remoteDomainName}' on '${props.directoryId}' not visible after create`,
              ),
            );
          }

          yield* session.note(`${props.directoryId}/${props.remoteDomainName}`);
          return toAttrs(props.directoryId, props.remoteDomainName, observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* ds
            .deleteConditionalForwarder({
              DirectoryId: output.directoryId,
              RemoteDomainName: output.remoteDomainName,
            })
            .pipe(
              retryWhileDirectoryUnavailable,
              // The forwarder — or the whole parent directory — being gone
              // is success.
              Effect.catchTag("EntityDoesNotExistException", () => Effect.void),
            );
        }),

        // Conditional forwarders are keyed by their parent directory; there
        // is no account-wide enumeration.
        list: () => Effect.succeed([]),
      };
    }),
  );
