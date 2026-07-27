import * as codeconnections from "@distilled.cloud/aws/codeconnections";
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
import { fetchObservedTags, syncResourceTags, toTagList } from "./internal.ts";

/**
 * VPC configuration provisioned for a {@link Host} whose self-managed
 * provider is only reachable from inside a VPC.
 */
export interface HostVpcConfiguration {
  /**
   * ID of the VPC connected to the provider's infrastructure.
   */
  vpcId: string;
  /**
   * IDs of the subnets associated with the VPC.
   */
  subnetIds: string[];
  /**
   * IDs of the security groups associated with the VPC.
   */
  securityGroupIds: string[];
  /**
   * PEM value of the TLS certificate used by the provider's infrastructure,
   * for endpoints served with a self-signed or private CA certificate.
   * This is public certificate material (not a private key).
   */
  tlsCertificate?: string;
}

export interface HostProps {
  /**
   * Name of the host (1-64 chars). If omitted a deterministic physical name
   * is generated. Changing the name replaces the host.
   */
  name?: string;
  /**
   * The self-managed source provider the host is installed on. Changing the
   * provider replaces the host.
   */
  providerType: "GitHubEnterpriseServer" | "GitLabSelfManaged";
  /**
   * Endpoint of the infrastructure the provider is installed on, e.g.
   * `https://ghe.example.com`.
   */
  providerEndpoint: string;
  /**
   * VPC configuration to provision for the host when the provider endpoint
   * is only reachable from inside a VPC.
   */
  vpcConfiguration?: HostVpcConfiguration;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Host extends Resource<
  "AWS.CodeConnections.Host",
  HostProps,
  {
    /** Physical name of the host. */
    hostName: string;
    /** ARN of the host (passed as `hostArn` to a `Connection`). */
    hostArn: string;
    /**
     * Host state. A freshly created host is `PENDING` until its setup is
     * completed **manually** in the AWS console; it then becomes
     * `AVAILABLE`.
     */
    hostStatus: string;
    /** The self-managed source provider. */
    providerType: string;
    /** Endpoint of the provider's infrastructure. */
    providerEndpoint: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeConnections host — the infrastructure representation of a
 * self-managed source provider (GitHub Enterprise Server or GitLab
 * self-managed). One host serves all connections to that provider.
 *
 * A host is created in the `PENDING` state. Completing it requires a
 * one-time setup performed **manually** in the AWS console — there is no
 * API to finish the setup. Once completed the host becomes `AVAILABLE` and
 * `Connection`s can reference it via `hostArn`.
 * @resource
 * @section Creating a Host
 * @example GitHub Enterprise Server Host (created PENDING)
 * ```typescript
 * const host = yield* CodeConnections.Host("GHE", {
 *   providerType: "GitHubEnterpriseServer",
 *   providerEndpoint: "https://ghe.example.com",
 * });
 * // host.hostStatus === "PENDING"
 * // Complete the setup in the console before creating connections on it.
 * ```
 *
 * @example Connection on a Host
 * ```typescript
 * const connection = yield* CodeConnections.Connection("GHEConn", {
 *   providerType: "GitHubEnterpriseServer",
 *   hostArn: host.hostArn,
 * });
 * ```
 *
 * @section Reaching a Private Endpoint
 * @example Host with VPC Configuration
 * ```typescript
 * const host = yield* CodeConnections.Host("PrivateGHE", {
 *   providerType: "GitHubEnterpriseServer",
 *   providerEndpoint: "https://ghe.internal.example.com",
 *   vpcConfiguration: {
 *     vpcId: vpc.vpcId,
 *     subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *     securityGroupIds: [securityGroup.securityGroupId],
 *   },
 * });
 * ```
 */
export const Host = Resource<Host>("AWS.CodeConnections.Host");

const toWireVpcConfiguration = (
  vpc: HostVpcConfiguration | undefined,
): codeconnections.VpcConfiguration | undefined =>
  vpc === undefined
    ? undefined
    : {
        VpcId: vpc.vpcId,
        SubnetIds: vpc.subnetIds,
        SecurityGroupIds: vpc.securityGroupIds,
        TlsCertificate: vpc.tlsCertificate,
      };

const sameVpcConfiguration = (
  observed: codeconnections.VpcConfiguration | undefined,
  desired: codeconnections.VpcConfiguration | undefined,
): boolean =>
  observed?.VpcId === desired?.VpcId &&
  JSON.stringify([...(observed?.SubnetIds ?? [])].sort()) ===
    JSON.stringify([...(desired?.SubnetIds ?? [])].sort()) &&
  JSON.stringify([...(observed?.SecurityGroupIds ?? [])].sort()) ===
    JSON.stringify([...(desired?.SecurityGroupIds ?? [])].sort()) &&
  (observed?.TlsCertificate ?? undefined) ===
    (desired?.TlsCertificate ?? undefined);

export const HostProvider = () =>
  Provider.effect(
    Host,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<HostProps>) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      /**
       * Read a host by ARN; a missing host reads as absent. `GetHost` does
       * not echo the ARN back, so it is re-attached from the input.
       */
      const getByArn = Effect.fn(function* (arn: string) {
        const response = yield* codeconnections
          .getHost({ HostArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response === undefined
          ? undefined
          : ({ ...response, HostArn: arn } satisfies codeconnections.Host);
      });

      /** Find a host by name (getHost only accepts an ARN). */
      const findByName = Effect.fn(function* (name: string) {
        const hosts = yield* codeconnections.listHosts.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.Hosts ?? []),
          ),
        );
        return hosts.find((h) => h.Name === name);
      });

      const toAttrs = (host: codeconnections.Host, name: string) => ({
        hostName: host.Name ?? name,
        hostArn: host.HostArn!,
        hostStatus: host.Status ?? "PENDING",
        providerType: host.ProviderType ?? "",
        providerEndpoint: host.ProviderEndpoint ?? "",
      });

      return {
        stables: ["hostName", "hostArn", "providerType"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Provider type is immutable — replace on change. Endpoint and VPC
          // configuration are mutable via UpdateHost.
          if (
            (news?.providerType ?? undefined) !==
            (olds?.providerType ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.hostName ?? (yield* toName(id, olds ?? {}));
          const host = output?.hostArn
            ? yield* getByArn(output.hostArn)
            : yield* findByName(name);
          if (host?.HostArn === undefined) return undefined;
          const attrs = toAttrs(host, name);
          const tags = yield* fetchObservedTags(attrs.hostArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.hostName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredVpc = toWireVpcConfiguration(news.vpcConfiguration);

          // 1. Observe — cloud state is authoritative.
          let observed = output?.hostArn
            ? yield* getByArn(output.hostArn)
            : yield* findByName(name);

          // 2. Ensure — create if missing. The host is created PENDING and
          // its setup is completed manually in the console.
          if (observed?.HostArn === undefined) {
            const created = yield* codeconnections.createHost({
              Name: name,
              ProviderType: news.providerType,
              ProviderEndpoint: news.providerEndpoint,
              VpcConfiguration: desiredVpc,
              Tags: toTagList(desiredTags),
            });
            observed = created.HostArn
              ? yield* getByArn(created.HostArn)
              : yield* findByName(name);
            if (observed?.HostArn === undefined) {
              observed = {
                Name: name,
                HostArn: created.HostArn,
                ProviderType: news.providerType,
                ProviderEndpoint: news.providerEndpoint,
                VpcConfiguration: desiredVpc,
                Status: "PENDING",
              };
            }
          }

          // 3. Sync — endpoint + VPC configuration, diffed against OBSERVED
          // cloud state; skip the API entirely on no-op.
          if (
            observed.ProviderEndpoint !== news.providerEndpoint ||
            !sameVpcConfiguration(observed.VpcConfiguration, desiredVpc)
          ) {
            yield* codeconnections.updateHost({
              HostArn: observed.HostArn!,
              ProviderEndpoint: news.providerEndpoint,
              VpcConfiguration: desiredVpc,
            });
            observed = (yield* getByArn(observed.HostArn!)) ?? observed;
          }

          // 4. Sync tags — diff against OBSERVED cloud tags.
          yield* syncResourceTags(observed.HostArn!, desiredTags);

          yield* session.note(name);
          return toAttrs(observed, name);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A host cannot be deleted while its VPC configuration is
          // initializing/deleting — retry the transient state, bounded.
          yield* codeconnections.deleteHost({ HostArn: output.hostArn }).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "ResourceUnavailableException",
              schedule: Schedule.exponential("2 seconds"),
              times: 8,
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),

        list: () =>
          codeconnections.listHosts.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.Hosts ?? [])
                .flatMap((h) =>
                  h.HostArn !== undefined
                    ? [
                        {
                          hostName: h.Name ?? "",
                          hostArn: h.HostArn,
                          hostStatus: h.Status ?? "PENDING",
                          providerType: h.ProviderType ?? "",
                          providerEndpoint: h.ProviderEndpoint ?? "",
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
