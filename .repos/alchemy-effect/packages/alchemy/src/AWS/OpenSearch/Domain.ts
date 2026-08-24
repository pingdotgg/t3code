import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  isDomainActive,
  isDomainDeletable,
  readDomainTags,
  repeatUntilDomainState,
  subsetDiffers,
} from "./internal.ts";

export interface DomainClusterConfig {
  /**
   * Instance type of the data nodes, e.g. `"t3.small.search"` (the cheapest
   * general-purpose type) or `"r7g.large.search"`.
   * @default "t3.small.search"
   */
  instanceType?: opensearch.OpenSearchPartitionInstanceType;
  /**
   * Number of data nodes in the cluster.
   * @default 1
   */
  instanceCount?: number;
  /**
   * Whether dedicated master nodes are enabled.
   */
  dedicatedMasterEnabled?: boolean;
  /**
   * Instance type of the dedicated master nodes.
   */
  dedicatedMasterType?: opensearch.OpenSearchPartitionInstanceType;
  /**
   * Number of dedicated master nodes (3 or 5 recommended).
   */
  dedicatedMasterCount?: number;
  /**
   * Whether data is distributed across multiple Availability Zones.
   */
  zoneAwarenessEnabled?: boolean;
  /**
   * Number of Availability Zones (2 or 3) when zone awareness is enabled.
   */
  availabilityZoneCount?: number;
  /**
   * Whether UltraWarm storage is enabled. Not supported on t2/t3 instances.
   */
  warmEnabled?: boolean;
  /**
   * Instance type of the UltraWarm nodes.
   */
  warmType?: opensearch.OpenSearchWarmPartitionInstanceType;
  /**
   * Number of UltraWarm nodes.
   */
  warmCount?: number;
  /**
   * Whether the domain runs in Multi-AZ with Standby mode.
   */
  multiAZWithStandbyEnabled?: boolean;
}

export interface DomainEbsOptions {
  /**
   * Whether EBS volumes are attached to the data nodes. Required for
   * EBS-only instance types like `t3.small.search`.
   * @default true
   */
  enabled?: boolean;
  /**
   * EBS volume type.
   * @default "gp3"
   */
  volumeType?: opensearch.VolumeType;
  /**
   * EBS volume size in GiB per data node.
   * @default 10
   */
  volumeSize?: number;
  /**
   * Provisioned IOPS (io1/gp3 volumes).
   */
  iops?: number;
  /**
   * Provisioned throughput in MiB/s (gp3 volumes).
   */
  throughput?: number;
}

export interface DomainEncryptionAtRestOptions {
  /**
   * Whether encryption at rest is enabled. Enabling on an existing domain is
   * an in-place update; DISABLING it is not supported and replaces the
   * domain. Not supported on t2 instance types.
   * @default true when `encryptionAtRest` is specified
   */
  enabled?: boolean;
  /**
   * Customer-managed KMS key ID used for encryption.
   * @default the AWS-owned aws/es key
   */
  kmsKeyId?: string;
}

export interface DomainEndpointOptionsProps {
  /**
   * Whether all traffic to the domain must arrive over HTTPS.
   */
  enforceHTTPS?: boolean;
  /**
   * Minimum TLS version for HTTPS connections, e.g.
   * `"Policy-Min-TLS-1-2-2019-07"`.
   */
  tlsSecurityPolicy?: opensearch.TLSSecurityPolicy;
  /**
   * Whether a custom endpoint is enabled for the domain.
   */
  customEndpointEnabled?: boolean;
  /**
   * Fully qualified custom endpoint, e.g. `"search.example.com"`.
   */
  customEndpoint?: string;
  /**
   * ACM certificate ARN for the custom endpoint.
   */
  customEndpointCertificateArn?: string;
}

export interface DomainSnapshotOptions {
  /**
   * Hour of the day (0-23, UTC) when automated snapshots are taken.
   */
  automatedSnapshotStartHour?: number;
}

export interface DomainVpcOptions {
  /**
   * Subnet IDs the domain's endpoints are placed into. One subnet unless
   * zone awareness is enabled.
   */
  subnetIds?: string[];
  /**
   * Security group IDs applied to the domain's network interfaces.
   */
  securityGroupIds?: string[];
}

export interface DomainProps {
  /**
   * Name of the domain. 3-28 characters; lowercase letters, numbers, and
   * hyphens; must start with a lowercase letter. If omitted, a deterministic
   * physical name is generated. Changing the name replaces the domain.
   */
  domainName?: string;
  /**
   * Engine version, e.g. `"OpenSearch_2.19"` or `"Elasticsearch_7.10"`.
   * Raising the version triggers an in-place engine upgrade.
   * @default the latest OpenSearch version
   */
  engineVersion?: string;
  /**
   * Cluster topology: data node type/count, dedicated masters, zone
   * awareness, and UltraWarm.
   * @default a single t3.small.search data node
   */
  clusterConfig?: DomainClusterConfig;
  /**
   * EBS storage attached to each data node.
   * @default 10 GiB gp3
   */
  ebsOptions?: DomainEbsOptions;
  /**
   * IAM resource-based access policy document controlling who can reach the
   * domain endpoint, either as a structured {@link PolicyDocument} or a raw
   * JSON string (escape hatch / adoption of pre-existing policies).
   */
  accessPolicies?: PolicyDocument | string;
  /**
   * IP address type of the endpoint — `"ipv4"` or `"dualstack"`.
   */
  ipAddressType?: opensearch.IPAddressType;
  /**
   * VPC placement for the domain endpoints. Omit for a public endpoint.
   */
  vpcOptions?: DomainVpcOptions;
  /**
   * Encryption of data at rest. Disabling on an existing domain replaces it.
   */
  encryptionAtRest?: DomainEncryptionAtRestOptions;
  /**
   * Whether node-to-node (in transit) encryption is enabled. Disabling on an
   * existing domain replaces it.
   */
  nodeToNodeEncryption?: boolean;
  /**
   * Advanced OpenSearch settings, e.g.
   * `{ "rest.action.multi.allow_explicit_index": "true" }`.
   */
  advancedOptions?: Record<string, string>;
  /**
   * HTTPS enforcement, TLS policy, and custom endpoint configuration.
   */
  domainEndpointOptions?: DomainEndpointOptionsProps;
  /**
   * Automated snapshot configuration.
   */
  snapshotOptions?: DomainSnapshotOptions;
  /**
   * User-defined tags for the domain.
   */
  tags?: Record<string, string>;
}

export interface Domain extends Resource<
  "AWS.OpenSearch.Domain",
  DomainProps,
  {
    /**
     * Name of the domain.
     */
    domainName: string;
    /**
     * ARN of the domain.
     */
    domainArn: string;
    /**
     * Unique identifier of the domain (`account-id/domain-name`).
     */
    domainId: string;
    /**
     * Engine version running on the domain (e.g. `OpenSearch_2.19`).
     */
    engineVersion: string | undefined;
    /**
     * Domain-specific HTTPS endpoint for search and index requests.
     */
    endpoint: string | undefined;
    /**
     * Whether domain creation has completed.
     */
    created: boolean;
    /**
     * Whether a configuration change is currently being applied.
     */
    processing: boolean;
    /**
     * Tags on the domain.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon OpenSearch Service domain — a managed OpenSearch/Elasticsearch
 * cluster with a search/HTTP endpoint.
 *
 * Domains take roughly 15-25 minutes to provision (and about as long for
 * blue/green configuration changes) and are billed per instance-hour while
 * they exist. Destroy domains you are not using.
 * @resource
 * @section Creating a Domain
 * @example Minimal Domain
 * ```typescript
 * // A single t3.small.search node with 10 GiB of gp3 EBS storage.
 * const domain = yield* Domain("Search", {});
 * ```
 *
 * @example Encrypted Domain with Access Policy
 * ```typescript
 * const domain = yield* Domain("Search", {
 *   engineVersion: "OpenSearch_2.19",
 *   clusterConfig: { instanceType: "t3.small.search", instanceCount: 1 },
 *   ebsOptions: { volumeType: "gp3", volumeSize: 10 },
 *   encryptionAtRest: { enabled: true },
 *   nodeToNodeEncryption: true,
 *   domainEndpointOptions: {
 *     enforceHTTPS: true,
 *     tlsSecurityPolicy: "Policy-Min-TLS-1-2-2019-07",
 *   },
 *   accessPolicies: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: `arn:aws:iam::${accountId}:root` },
 *         Action: ["es:*"],
 *         Resource: `arn:aws:es:${region}:${accountId}:domain/*`,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Multi-AZ Cluster
 * @example Zone-Aware Cluster
 * ```typescript
 * const domain = yield* Domain("Search", {
 *   clusterConfig: {
 *     instanceType: "r7g.large.search",
 *     instanceCount: 2,
 *     zoneAwarenessEnabled: true,
 *     availabilityZoneCount: 2,
 *   },
 * });
 * ```
 */
export const Domain = Resource<Domain>("AWS.OpenSearch.Domain");

const DEFAULT_INSTANCE_TYPE = "t3.small.search";

const toClusterConfig = (
  config: DomainClusterConfig | undefined,
): opensearch.ClusterConfig => ({
  InstanceType: config?.instanceType ?? DEFAULT_INSTANCE_TYPE,
  InstanceCount: config?.instanceCount ?? 1,
  DedicatedMasterEnabled: config?.dedicatedMasterEnabled,
  DedicatedMasterType: config?.dedicatedMasterType,
  DedicatedMasterCount: config?.dedicatedMasterCount,
  ZoneAwarenessEnabled: config?.zoneAwarenessEnabled,
  ZoneAwarenessConfig:
    config?.availabilityZoneCount !== undefined
      ? { AvailabilityZoneCount: config.availabilityZoneCount }
      : undefined,
  WarmEnabled: config?.warmEnabled,
  WarmType: config?.warmType,
  WarmCount: config?.warmCount,
  MultiAZWithStandbyEnabled: config?.multiAZWithStandbyEnabled,
});

const toEbsOptions = (
  ebs: DomainEbsOptions | undefined,
): opensearch.EBSOptions =>
  ebs?.enabled === false
    ? { EBSEnabled: false }
    : {
        EBSEnabled: true,
        VolumeType: ebs?.volumeType ?? "gp3",
        VolumeSize: ebs?.volumeSize ?? 10,
        Iops: ebs?.iops,
        Throughput: ebs?.throughput,
      };

const toEndpointOptions = (
  options: DomainEndpointOptionsProps | undefined,
): opensearch.DomainEndpointOptions | undefined =>
  options === undefined
    ? undefined
    : {
        EnforceHTTPS: options.enforceHTTPS,
        TLSSecurityPolicy: options.tlsSecurityPolicy,
        CustomEndpointEnabled: options.customEndpointEnabled,
        CustomEndpoint: options.customEndpoint,
        CustomEndpointCertificateArn: options.customEndpointCertificateArn,
      };

const toAccessPolicies = (
  policy: PolicyDocument | string | undefined,
): string | undefined =>
  policy === undefined
    ? undefined
    : typeof policy === "string"
      ? policy
      : stringifyPolicyDocument(policy);

const toVpcOptions = (
  options: DomainVpcOptions | undefined,
): opensearch.VPCOptions | undefined =>
  options === undefined
    ? undefined
    : {
        SubnetIds: options.subnetIds,
        SecurityGroupIds: options.securityGroupIds,
      };

export const DomainProvider = () =>
  Provider.effect(
    Domain,
    Effect.gen(function* () {
      const toName = (id: string, props: DomainProps) =>
        props.domainName
          ? Effect.succeed(props.domainName)
          : createPhysicalName({ id, maxLength: 28, lowercase: true });

      const readDomain = Effect.fn(function* (name: string) {
        return yield* opensearch.describeDomain({ DomainName: name }).pipe(
          Effect.map((response) => response.DomainStatus),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const waitForActive = Effect.fn(function* (name: string) {
        const domain = yield* repeatUntilDomainState(
          readDomain(name),
          isDomainActive,
        );
        if (domain === undefined) {
          return yield* Effect.fail(
            new Error(`OpenSearch domain '${name}' not found while waiting`),
          );
        }
        return domain;
      });

      const toAttrs = Effect.fn(function* (domain: opensearch.DomainStatus) {
        return {
          domainName: domain.DomainName,
          domainArn: domain.ARN,
          domainId: domain.DomainId,
          engineVersion: domain.EngineVersion,
          endpoint: domain.Endpoint ?? domain.EndpointV2,
          created: domain.Created === true,
          processing: domain.Processing === true,
          tags: yield* readDomainTags(domain.ARN),
        };
      });

      return {
        stables: ["domainName", "domainArn", "domainId"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const o: DomainProps = olds ?? {};
          const n: DomainProps = news ?? {};
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // Encryption at rest and node-to-node encryption can be ENABLED
          // in place but never disabled — disabling replaces the domain.
          if (
            o.encryptionAtRest?.enabled !== false &&
            o.encryptionAtRest !== undefined &&
            n.encryptionAtRest?.enabled === false
          ) {
            return { action: "replace" } as const;
          }
          if (
            o.nodeToNodeEncryption === true &&
            n.nodeToNodeEncryption === false
          ) {
            return { action: "replace" } as const;
          }
          // Moving a domain between public and VPC endpoints replaces it.
          if ((o.vpcOptions === undefined) !== (n.vpcOptions === undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.domainName ?? (yield* toName(id, olds ?? {}));
          const domain = yield* readDomain(name);
          if (domain === undefined) return undefined;
          const attrs = yield* toAttrs(domain);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const name = output?.domainName ?? (yield* toName(id, props));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readDomain(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* opensearch
              .createDomain({
                DomainName: name,
                EngineVersion: props.engineVersion,
                ClusterConfig: toClusterConfig(props.clusterConfig),
                EBSOptions: toEbsOptions(props.ebsOptions),
                AccessPolicies: toAccessPolicies(props.accessPolicies),
                IPAddressType: props.ipAddressType,
                SnapshotOptions:
                  props.snapshotOptions !== undefined
                    ? {
                        AutomatedSnapshotStartHour:
                          props.snapshotOptions.automatedSnapshotStartHour,
                      }
                    : undefined,
                VPCOptions: toVpcOptions(props.vpcOptions),
                EncryptionAtRestOptions:
                  props.encryptionAtRest !== undefined
                    ? {
                        Enabled: props.encryptionAtRest.enabled ?? true,
                        KmsKeyId: props.encryptionAtRest.kmsKeyId,
                      }
                    : undefined,
                NodeToNodeEncryptionOptions:
                  props.nodeToNodeEncryption !== undefined
                    ? { Enabled: props.nodeToNodeEncryption }
                    : undefined,
                AdvancedOptions: props.advancedOptions,
                DomainEndpointOptions: toEndpointOptions(
                  props.domainEndpointOptions,
                ),
                TagList: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
          }

          // Provisioning and blue/green config changes both surface as
          // Processing=true; wait (bounded) so config updates do not fail.
          observed = yield* waitForActive(name);

          // 3. Sync — compute the update delta from OBSERVED state.
          const update: opensearch.UpdateDomainConfigRequest = {
            DomainName: name,
          };
          let mutated = false;

          const desiredCluster = toClusterConfig(props.clusterConfig);
          if (subsetDiffers(desiredCluster, observed.ClusterConfig)) {
            update.ClusterConfig = desiredCluster;
            mutated = true;
          }
          const desiredEbs = toEbsOptions(props.ebsOptions);
          if (subsetDiffers(desiredEbs, observed.EBSOptions)) {
            update.EBSOptions = desiredEbs;
            mutated = true;
          }
          // Drift-compare canonicalized documents so key order / encoding
          // differences in what OpenSearch echoes back never cause a
          // spurious blue/green config change on re-deploy.
          if (
            props.accessPolicies !== undefined &&
            normalizePolicyDocument(props.accessPolicies) !==
              normalizePolicyDocument(observed.AccessPolicies ?? "")
          ) {
            update.AccessPolicies = toAccessPolicies(props.accessPolicies);
            mutated = true;
          }
          if (
            props.ipAddressType !== undefined &&
            props.ipAddressType !== observed.IPAddressType
          ) {
            update.IPAddressType = props.ipAddressType;
            mutated = true;
          }
          if (
            props.snapshotOptions?.automatedSnapshotStartHour !== undefined &&
            props.snapshotOptions.automatedSnapshotStartHour !==
              observed.SnapshotOptions?.AutomatedSnapshotStartHour
          ) {
            update.SnapshotOptions = {
              AutomatedSnapshotStartHour:
                props.snapshotOptions.automatedSnapshotStartHour,
            };
            mutated = true;
          }
          const desiredVpc = toVpcOptions(props.vpcOptions);
          if (
            desiredVpc !== undefined &&
            subsetDiffers(desiredVpc, {
              SubnetIds: observed.VPCOptions?.SubnetIds,
              SecurityGroupIds: observed.VPCOptions?.SecurityGroupIds,
            })
          ) {
            update.VPCOptions = desiredVpc;
            mutated = true;
          }
          if (
            props.advancedOptions !== undefined &&
            subsetDiffers(props.advancedOptions, observed.AdvancedOptions)
          ) {
            update.AdvancedOptions = props.advancedOptions;
            mutated = true;
          }
          const desiredEndpointOptions = toEndpointOptions(
            props.domainEndpointOptions,
          );
          if (
            desiredEndpointOptions !== undefined &&
            subsetDiffers(
              desiredEndpointOptions,
              observed.DomainEndpointOptions,
            )
          ) {
            update.DomainEndpointOptions = desiredEndpointOptions;
            mutated = true;
          }
          // Encryption can only be enabled in place (disable = replacement,
          // handled by diff).
          if (
            props.encryptionAtRest !== undefined &&
            props.encryptionAtRest.enabled !== false &&
            observed.EncryptionAtRestOptions?.Enabled !== true
          ) {
            update.EncryptionAtRestOptions = {
              Enabled: true,
              KmsKeyId: props.encryptionAtRest.kmsKeyId,
            };
            mutated = true;
          }
          if (
            props.nodeToNodeEncryption === true &&
            observed.NodeToNodeEncryptionOptions?.Enabled !== true
          ) {
            update.NodeToNodeEncryptionOptions = { Enabled: true };
            mutated = true;
          }

          if (mutated) {
            yield* opensearch.updateDomainConfig(update);
            observed = yield* waitForActive(name);
          }

          // 3b. Engine upgrades run through the dedicated upgrade API.
          if (
            props.engineVersion !== undefined &&
            observed.EngineVersion !== undefined &&
            observed.EngineVersion !== props.engineVersion
          ) {
            yield* opensearch.upgradeDomain({
              DomainName: name,
              TargetVersion: props.engineVersion,
            });
            observed = yield* waitForActive(name);
          }

          // 3c. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readDomainTags(observed.ARN);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* opensearch.addTags({ ARN: observed.ARN, TagList: upsert });
          }
          if (removed.length > 0) {
            yield* opensearch.removeTags({
              ARN: observed.ARN,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.domainName;
          // A domain mid-create/config-change may reject deletion — wait
          // (bounded, tolerant) for it to settle first. Already deleting
          // (or gone) is success.
          yield* repeatUntilDomainState(
            readDomain(name),
            isDomainDeletable,
          ).pipe(Effect.catch(() => Effect.succeed(undefined)));
          yield* opensearch
            .deleteDomain({ DomainName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          opensearch.listDomainNames({}).pipe(
            Effect.map((response) =>
              (response.DomainNames ?? [])
                .map((info) => info.DomainName)
                .filter((name): name is string => name !== undefined),
            ),
            Effect.flatMap(
              Effect.forEach(
                (name) =>
                  opensearch.describeDomain({ DomainName: name }).pipe(
                    Effect.map((response) => response.DomainStatus),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((domains) =>
              domains.filter(
                (domain): domain is opensearch.DomainStatus =>
                  domain !== undefined,
              ),
            ),
            Effect.flatMap(
              Effect.forEach((domain) => toAttrs(domain), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
