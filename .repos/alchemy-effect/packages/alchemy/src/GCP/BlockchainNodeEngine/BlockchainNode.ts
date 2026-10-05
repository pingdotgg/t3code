import * as bne from "@distilled.cloud/gcp/blockchainnodeengine_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  COLLECTION,
  DEFAULT_BLOCKCHAIN_TYPE,
  DEFAULT_CONSENSUS_CLIENT,
  DEFAULT_EXECUTION_CLIENT,
  DEFAULT_NETWORK,
  DEFAULT_NODE_TYPE,
  ResourceNotResolved,
  fieldMask,
  isReadyState,
  listAtLocation,
  listLabeledPages,
  normalizeEnum,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameEnum,
  sameStringList,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ValidatorConfig = {
  /**
   * Ethereum address the beacon client sends fee rewards to when the
   * validator client has no recipient configured.
   */
  beaconFeeRecipient?: string;
  /**
   * MEV-relay URLs. When set, a GCP-managed MEV-boost service is
   * configured on the beacon client.
   */
  mevRelayUrls?: string[];
  /**
   * Deploy a GCP-managed validator client next to the beacon client.
   * Immutable — changing it replaces the node.
   */
  managedValidatorClient?: boolean;
};

export type GethDetails = {
  /**
   * Geth garbage collection mode (`FULL` or `ARCHIVE`). Immutable —
   * changing it replaces the node.
   */
  garbageCollectionMode?:
    | bne.GethDetailsGarbageCollectionModeEnum
    | (string & {});
};

export type EthereumDetails = {
  /**
   * Ethereum node type (`LIGHT`, `FULL`, `ARCHIVE`). Immutable —
   * changing it replaces the node.
   * @default "FULL"
   */
  nodeType?: bne.EthereumDetailsNodeTypeEnum | (string & {});
  /**
   * Enable JSON-RPC `debug` namespace methods. Immutable — changing it
   * replaces the node.
   * @default false
   */
  apiEnableDebug?: boolean;
  /**
   * Ethereum network (`MAINNET`, `TESTNET_SEPOLIA`, `TESTNET_HOLESKY`,
   * `TESTNET_GOERLI_PRATER`). Immutable — changing it replaces the node.
   * @default "TESTNET_SEPOLIA"
   */
  network?: bne.EthereumDetailsNetworkEnum | (string & {});
  /**
   * Validator / MEV configuration. `beaconFeeRecipient` and
   * `mevRelayUrls` update in place; `managedValidatorClient` is
   * immutable.
   */
  validatorConfig?: ValidatorConfig;
  /**
   * Geth-specific options. Immutable.
   */
  gethDetails?: GethDetails;
  /**
   * Execution client (`GETH` or `ERIGON`). Immutable — changing it
   * replaces the node.
   * @default "GETH"
   */
  executionClient?: bne.EthereumDetailsExecutionClientEnum | (string & {});
  /**
   * Consensus client (`LIGHTHOUSE` or `ERIGON_EMBEDDED_CONSENSUS_LAYER`).
   * Immutable — changing it replaces the node.
   * @default "LIGHTHOUSE"
   */
  consensusClient?: bne.EthereumDetailsConsensusClientEnum | (string & {});
  /**
   * Enable JSON-RPC `admin` namespace methods. Immutable — changing it
   * replaces the node.
   * @default false
   */
  apiEnableAdmin?: boolean;
};

export type EndpointInfo = {
  /** JSON-RPC HTTPS endpoint. */
  jsonRpcApiEndpoint: string | undefined;
  /** WebSocket endpoint. */
  websocketsApiEndpoint: string | undefined;
};

export type ConnectionInfo = {
  /**
   * Private Service Connect attachment
   * (`projects/{project}/regions/{region}/serviceAttachments/{name}`).
   */
  serviceAttachment: string | undefined;
  /** Public JSON-RPC / WebSocket endpoints, when exposed. */
  endpointInfo: EndpointInfo | undefined;
};

export type EthereumEndpoints = {
  /** Beacon API endpoint. */
  beaconApiEndpoint: string | undefined;
  /** Beacon Prometheus metrics endpoint. */
  beaconPrometheusMetricsApiEndpoint: string | undefined;
  /** Execution-client Prometheus metrics endpoint. */
  executionClientPrometheusMetricsApiEndpoint: string | undefined;
};

export type BlockchainNodeProps = {
  /**
   * Node id (the `{blockchainNode}` segment of
   * `projects/{project}/locations/{location}/blockchainNodes/{blockchainNode}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters, start with a letter, and end
   * with a letter or digit. Immutable — changing it replaces the node.
   */
  blockchainNodeId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the node. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Blockchain type. Ethereum is the only supported value. Immutable —
   * changing it replaces the node.
   * @default "ETHEREUM"
   */
  blockchainType?: bne.BlockchainNodeBlockchainTypeEnum | (string & {});
  /**
   * Restrict access to Private Service Connect (no public endpoints).
   * Deprecated by the API in favor of public endpoints. Immutable —
   * changing it replaces the node.
   * @default false
   */
  privateServiceConnectEnabled?: boolean;
  /**
   * Ethereum-specific configuration. Immutable fields (`network`,
   * `nodeType`, clients, API namespaces, Geth GC mode, managed
   * validator) replace the node. Validator fee recipient and MEV
   * relays update in place.
   */
  ethereumDetails?: EthereumDetails;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BlockchainNode = Resource<
  "GCP.BlockchainNodeEngine.BlockchainNode",
  BlockchainNodeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/blockchainNodes/{blockchainNode}`. */
    name: string;
    /** Node id (last path segment). */
    blockchainNodeId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Blockchain type (`ETHEREUM`). */
    blockchainType: string | undefined;
    /** Whether Private Service Connect is enabled. */
    privateServiceConnectEnabled: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Ethereum configuration currently applied. */
    ethereumDetails: EthereumDetails | undefined;
    /** Ethereum-specific additional endpoints. */
    additionalEndpoints: EthereumEndpoints | undefined;
    /** Connection information (JSON-RPC / WebSocket / PSC). */
    connectionInfo: ConnectionInfo | undefined;
    /** Server-reported state (`CREATING`, `RUNNING`, `SYNCING`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Blockchain Node Engine node — a fully managed Ethereum execution
 * and consensus client.
 *
 * Changing `blockchainNodeId`, `location`, `blockchainType`,
 * `privateServiceConnectEnabled`, or immutable Ethereum fields
 * (`network`, `nodeType`, execution/consensus clients, API namespaces,
 * Geth garbage collection, managed validator) replaces the node.
 * Labels, `beaconFeeRecipient`, and `mevRelayUrls` update in place.
 *
 * Provisioning typically takes 15-45 minutes and the API is
 * entitlement-gated. Prefer `TESTNET_SEPOLIA` over `MAINNET`.
 *
 * ### Creating a Node
 * **Example:** Generated name, Sepolia full node
 * ```typescript
 * const node = yield* GCP.BlockchainNodeEngine.BlockchainNode("Sepolia", {});
 * ```
 *
 * **Example:** Explicit id, labels, and Geth archive
 * ```typescript
 * const node = yield* GCP.BlockchainNodeEngine.BlockchainNode("Sepolia", {
 *   blockchainNodeId: "app-sepolia",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   ethereumDetails: {
 *     network: "TESTNET_SEPOLIA",
 *     nodeType: "ARCHIVE",
 *     executionClient: "GETH",
 *     consensusClient: "LIGHTHOUSE",
 *     gethDetails: { garbageCollectionMode: "ARCHIVE" },
 *   },
 * });
 * ```
 *
 * ### Validator configuration
 * **Example:** Suggested fee recipient and MEV relays
 * ```typescript
 * const node = yield* GCP.BlockchainNodeEngine.BlockchainNode("Sepolia", {
 *   ethereumDetails: {
 *     network: "TESTNET_SEPOLIA",
 *     nodeType: "FULL",
 *     validatorConfig: {
 *       beaconFeeRecipient: "0x0000000000000000000000000000000000000000",
 *       mevRelayUrls: ["https://relay.example"],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category BlockchainNodeEngine
 */
export const BlockchainNode = Resource<BlockchainNode>(
  "GCP.BlockchainNodeEngine.BlockchainNode",
);

const toValidator = (
  config: bne.ValidatorConfig | ValidatorConfig | undefined,
): ValidatorConfig | undefined => {
  if (config === undefined) return undefined;
  if (
    config.beaconFeeRecipient === undefined &&
    (config.mevRelayUrls === undefined || config.mevRelayUrls.length === 0) &&
    config.managedValidatorClient === undefined
  ) {
    return undefined;
  }
  return {
    beaconFeeRecipient: config.beaconFeeRecipient,
    mevRelayUrls: config.mevRelayUrls ? [...config.mevRelayUrls] : undefined,
    managedValidatorClient: config.managedValidatorClient,
  };
};

const toGeth = (
  details: bne.GethDetails | GethDetails | undefined,
): GethDetails | undefined => {
  if (details?.garbageCollectionMode === undefined) return undefined;
  return { garbageCollectionMode: details.garbageCollectionMode };
};

const toEthereum = (
  details: bne.EthereumDetails | EthereumDetails | undefined,
): EthereumDetails | undefined => {
  if (details === undefined) return undefined;
  return {
    nodeType: details.nodeType,
    apiEnableDebug: details.apiEnableDebug,
    network: details.network,
    validatorConfig: toValidator(details.validatorConfig),
    gethDetails: toGeth(details.gethDetails),
    executionClient: details.executionClient,
    consensusClient: details.consensusClient,
    apiEnableAdmin: details.apiEnableAdmin,
  };
};

const mergeEthereum = (
  previous: EthereumDetails | undefined,
  next: EthereumDetails | undefined,
): EthereumDetails => ({
  nodeType: next?.nodeType ?? previous?.nodeType,
  apiEnableDebug: next?.apiEnableDebug ?? previous?.apiEnableDebug,
  network: next?.network ?? previous?.network,
  validatorConfig: {
    beaconFeeRecipient:
      next?.validatorConfig?.beaconFeeRecipient ??
      previous?.validatorConfig?.beaconFeeRecipient,
    mevRelayUrls:
      next?.validatorConfig?.mevRelayUrls ??
      previous?.validatorConfig?.mevRelayUrls,
    managedValidatorClient:
      next?.validatorConfig?.managedValidatorClient ??
      previous?.validatorConfig?.managedValidatorClient,
  },
  gethDetails: {
    garbageCollectionMode:
      next?.gethDetails?.garbageCollectionMode ??
      previous?.gethDetails?.garbageCollectionMode,
  },
  executionClient: next?.executionClient ?? previous?.executionClient,
  consensusClient: next?.consensusClient ?? previous?.consensusClient,
  apiEnableAdmin: next?.apiEnableAdmin ?? previous?.apiEnableAdmin,
});

const ethereumIdentityKey = (details: EthereumDetails | undefined) =>
  JSON.stringify({
    nodeType: normalizeEnum(details?.nodeType, ""),
    network: normalizeEnum(details?.network, ""),
    executionClient: normalizeEnum(details?.executionClient, ""),
    consensusClient: normalizeEnum(details?.consensusClient, ""),
    apiEnableAdmin: details?.apiEnableAdmin === true,
    apiEnableDebug: details?.apiEnableDebug === true,
    gc: normalizeEnum(details?.gethDetails?.garbageCollectionMode, ""),
    managedValidator: details?.validatorConfig?.managedValidatorClient === true,
  });

const desiredEthereum = (news: BlockchainNodeProps): EthereumDetails => {
  const details = news.ethereumDetails;
  return {
    nodeType: normalizeEnum(details?.nodeType, DEFAULT_NODE_TYPE),
    apiEnableDebug: details?.apiEnableDebug === true,
    network: normalizeEnum(details?.network, DEFAULT_NETWORK),
    validatorConfig: details?.validatorConfig,
    gethDetails: details?.gethDetails,
    executionClient: normalizeEnum(
      details?.executionClient,
      DEFAULT_EXECUTION_CLIENT,
    ),
    consensusClient: normalizeEnum(
      details?.consensusClient,
      DEFAULT_CONSENSUS_CLIENT,
    ),
    apiEnableAdmin: details?.apiEnableAdmin === true,
  };
};

const toCreateBody = (
  news: BlockchainNodeProps,
  desiredLabels: Record<string, string>,
): bne.BlockchainNode => {
  const ethereum = desiredEthereum(news);
  return {
    blockchainType: normalizeEnum(news.blockchainType, DEFAULT_BLOCKCHAIN_TYPE),
    privateServiceConnectEnabled: news.privateServiceConnectEnabled === true,
    labels: desiredLabels,
    ethereumDetails: {
      nodeType: ethereum.nodeType,
      apiEnableDebug: ethereum.apiEnableDebug,
      network: ethereum.network,
      validatorConfig: ethereum.validatorConfig,
      gethDetails: ethereum.gethDetails,
      executionClient: ethereum.executionClient,
      consensusClient: ethereum.consensusClient,
      apiEnableAdmin: ethereum.apiEnableAdmin,
    },
  };
};

const toEndpoints = (
  endpoints: bne.EthereumEndpoints | undefined,
): EthereumEndpoints | undefined => {
  if (endpoints === undefined) return undefined;
  return {
    beaconApiEndpoint: endpoints.beaconApiEndpoint,
    beaconPrometheusMetricsApiEndpoint:
      endpoints.beaconPrometheusMetricsApiEndpoint,
    executionClientPrometheusMetricsApiEndpoint:
      endpoints.executionClientPrometheusMetricsApiEndpoint,
  };
};

const toConnection = (
  info: bne.ConnectionInfo | undefined,
): ConnectionInfo | undefined => {
  if (info === undefined) return undefined;
  return {
    serviceAttachment: info.serviceAttachment,
    endpointInfo: info.endpointInfo
      ? {
          jsonRpcApiEndpoint: info.endpointInfo.jsonRpcApiEndpoint,
          websocketsApiEndpoint: info.endpointInfo.websocketsApiEndpoint,
        }
      : undefined,
  };
};

const toAttrs = (node: bne.BlockchainNode, project: string, region: string) => {
  const name = node.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    blockchainNodeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    blockchainType: node.blockchainType,
    privateServiceConnectEnabled: node.privateServiceConnectEnabled === true,
    labels: userLabels(node.labels),
    ethereumDetails: toEthereum(node.ethereumDetails),
    additionalEndpoints: toEndpoints(node.ethereumDetails?.additionalEndpoints),
    connectionInfo: toConnection(node.connectionInfo),
    state: node.state,
    createTime: node.createTime,
    updateTime: node.updateTime,
  };
};

const isPlaceholder = (node: bne.BlockchainNode) => {
  const name = node.name ?? "";
  return (
    name.length === 0 ||
    name.endsWith(`/${COLLECTION}/-`) ||
    name.endsWith(`/${COLLECTION}/`)
  );
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : bne
        .getProjectsLocationsBlockchainNodes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      bne.listProjectsLocationsBlockchainNodes.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.blockchainNodes,
      (item) => item.labels,
    ),
  );

export const BlockchainNodeProvider = () =>
  Provider.succeed(BlockchainNode, {
    stables: [
      "name",
      "blockchainNodeId",
      "project",
      "location",
      "blockchainType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.blockchainType ?? output?.blockchainType;
      const nextType = news.blockchainType ?? previousType;
      const previousPsc =
        olds?.privateServiceConnectEnabled ??
        output?.privateServiceConnectEnabled;
      const nextPsc = news.privateServiceConnectEnabled ?? previousPsc ?? false;
      const previousEthereum = toEthereum(
        olds?.ethereumDetails ?? output?.ethereumDetails,
      );
      const nextEthereum = mergeEthereum(
        previousEthereum,
        news.ethereumDetails,
      );
      return replaceOnIdentity({
        previousId: olds?.blockchainNodeId ?? output?.blockchainNodeId,
        nextId:
          news.blockchainNodeId ??
          olds?.blockchainNodeId ??
          output?.blockchainNodeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType !== undefined &&
            nextType !== undefined &&
            !sameEnum(previousType, nextType)) ||
          (previousPsc === true) !== (nextPsc === true) ||
          (previousEthereum !== undefined &&
            ethereumIdentityKey(previousEthereum) !==
              ethereumIdentityKey(nextEthereum)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const blockchainNodeId = yield* toPhysicalId(
        id,
        olds?.blockchainNodeId,
        output?.blockchainNodeId,
        "node",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, blockchainNodeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items
          .filter((item) => !isPlaceholder(item))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const blockchainNodeId = yield* toPhysicalId(
        id,
        news.blockchainNodeId,
        output?.blockchainNodeId,
        "node",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, blockchainNodeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bne
          .createProjectsLocationsBlockchainNodes({
            parent: parentOf(env.project, location),
            blockchainNodeId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      let latest = current;
      if (!isReadyState(latest.state)) {
        latest = yield* waitUntilReady(
          getByName(latest.name ?? name),
          latest.name ?? name,
          (node) => node.state,
        );
      }

      const observedLabels = tagRecord(latest.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const desiredValidator = news.ethereumDetails?.validatorConfig;
      const observedValidator = latest.ethereumDetails?.validatorConfig;
      const feeChanged =
        desiredValidator?.beaconFeeRecipient !== undefined &&
        !sameText(
          (observedValidator?.beaconFeeRecipient ?? "").toLowerCase(),
          desiredValidator.beaconFeeRecipient.toLowerCase(),
        );
      const relaysChanged =
        desiredValidator?.mevRelayUrls !== undefined &&
        !sameStringList(
          observedValidator?.mevRelayUrls,
          desiredValidator.mevRelayUrls,
        );

      const mask = fieldMask([
        labelsChanged && "labels",
        feeChanged && "ethereum_details.validator_config.beacon_fee_recipient",
        relaysChanged && "ethereum_details.validator_config.mev_relay_urls",
      ]);

      if (mask.length > 0) {
        const operation = yield* bne.patchProjectsLocationsBlockchainNodes({
          name: latest.name ?? name,
          updateMask: mask,
          body: {
            name: latest.name ?? name,
            labels: desiredLabels,
            ethereumDetails:
              feeChanged || relaysChanged
                ? {
                    validatorConfig: {
                      beaconFeeRecipient:
                        desiredValidator?.beaconFeeRecipient ??
                        observedValidator?.beaconFeeRecipient,
                      mevRelayUrls:
                        desiredValidator?.mevRelayUrls ??
                        observedValidator?.mevRelayUrls,
                    },
                  }
                : undefined,
          },
        });
        yield* waitForOperation(operation);
        latest = yield* waitUntilExists(
          getByName(latest.name ?? name),
          latest.name ?? name,
        );
      }

      return toAttrs(latest, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* bne
        .deleteProjectsLocationsBlockchainNodes({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
