import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface NetworkConnectorProps {
  /**
   * A unique name for the network connector within your account and Region.
   * Must be 1-64 characters of letters, numbers, hyphens, or underscores.
   * If omitted, a unique name is generated. Changing the name replaces the
   * connector.
   */
  name?: string;

  /**
   * The IDs of the VPC subnets in which the connector provisions elastic
   * network interfaces (ENIs). These determine which VPC the connector routes
   * egress traffic into.
   */
  subnetIds: string[];

  /**
   * The IDs of the security groups applied to the connector's elastic network
   * interfaces.
   */
  securityGroupIds?: string[];

  /**
   * The IP addressing mode for the connector's egress path.
   * @default "IPv4"
   */
  networkProtocol?: lambdacore.NetworkProtocol;

  /**
   * The Lambda compute resource types that may attach to this connector.
   * @default ["MicroVm"]
   */
  associatedComputeResourceTypes?: lambdacore.ComputeResourceType[];

  /**
   * The ARN of the IAM role that Lambda assumes to manage elastic network
   * interfaces in your VPC. The role needs `ec2:CreateNetworkInterface` and
   * the related describe/delete permissions.
   */
  operatorRole?: string;

  /**
   * Tags to apply to the network connector. Tags are set at creation time and
   * cannot be changed afterwards (the API exposes no tagging operations).
   */
  tags?: Record<string, string>;
}

export interface NetworkConnector extends Resource<
  "AWS.Lambda.NetworkConnector",
  NetworkConnectorProps,
  {
    /**
     * The Amazon Resource Name (ARN) of the network connector.
     */
    networkConnectorArn: string;
    /**
     * The unique ID of the network connector.
     */
    networkConnectorId: string;
    /**
     * The name of the network connector.
     */
    name: string;
    /**
     * The current state of the network connector (e.g. `ACTIVE`, `PENDING`,
     * `FAILED`).
     */
    state: lambdacore.NetworkConnectorState;
    /**
     * The ARN of the IAM operator role, if one was configured.
     */
    operatorRole?: string;
    /**
     * The subnet IDs the connector provisions ENIs in.
     */
    subnetIds?: string[];
    /**
     * The security group IDs applied to the connector's ENIs.
     */
    securityGroupIds?: string[];
    /**
     * The IP addressing mode of the connector's egress path.
     */
    networkProtocol?: lambdacore.NetworkProtocol;
    /**
     * The compute resource types associated with the connector.
     */
    associatedComputeResourceTypes?: lambdacore.ComputeResourceType[];
    /**
     * The monotonic version of the connector, incremented on each update.
     */
    version?: number;
    /**
     * The timestamp of the connector's most recent modification (ISO 8601).
     */
    lastModified?: string;
  },
  never,
  Providers
> {}

/**
 * A Lambda network connector that gives Lambda compute resources — notably
 * {@link MicrovmImage} MicroVMs — a managed egress path into your VPC. The
 * connector provisions elastic network interfaces (ENIs) in the subnets you
 * specify so workloads can reach private resources such as databases, caches,
 * and internal APIs.
 *
 * Creation is asynchronous: the connector starts in `PENDING` while ENIs are
 * provisioned (this can take several minutes) and the provider waits until it
 * reaches `ACTIVE`. The connector name is immutable, so renaming it replaces the
 * connector; the VPC configuration and operator role can be updated in place.
 *
 * @resource
 * @section Creating a Network Connector
 * @example VPC Egress Connector
 * ```typescript
 * const connector = yield* AWS.Lambda.NetworkConnector("Egress", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 *   operatorRole: role.roleArn,
 * });
 * ```
 *
 * @section Dual-Stack Networking
 * @example IPv4 + IPv6 Egress
 * ```typescript
 * const connector = yield* AWS.Lambda.NetworkConnector("DualStack", {
 *   subnetIds: [subnet.subnetId],
 *   securityGroupIds: [securityGroup.groupId],
 *   networkProtocol: "DualStack",
 * });
 * ```
 *
 * @section Using a Connector with MicroVMs
 * A connector is the producer; a {@link MicrovmImage} (or a per-run
 * `RunMicrovm` call) is the consumer. Reference it by ARN in
 * `egressNetworkConnectors`.
 * @example Image-level Egress
 * ```typescript
 * const image = yield* AWS.Lambda.MicrovmImage("Sandbox", {
 *   main: import.meta.filename,
 *   buildRole,
 *   egressNetworkConnectors: [connector.networkConnectorArn],
 * });
 * ```
 */
export const NetworkConnector = Resource<NetworkConnector>(
  "AWS.Lambda.NetworkConnector",
);

export const NetworkConnectorProvider = () =>
  Provider.succeed(NetworkConnector, {
    stables: ["networkConnectorArn", "networkConnectorId", "name"],

    diff: Effect.fn(function* ({ id, olds, news }) {
      if (!isResolved(news)) return;
      const oldName = yield* resolveName(id, olds.name);
      const newName = yield* resolveName(id, news.name);
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const identifier =
        output?.networkConnectorId ?? output?.networkConnectorArn;
      const connector = identifier
        ? yield* getConnector(identifier)
        : yield* getConnector(yield* resolveName(id, olds?.name));
      return connector ? toAttrs(connector) : undefined;
    }),

    list: () =>
      Effect.gen(function* () {
        const summaries = yield* lambdacore.listNetworkConnectors
          .items({})
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const connectors = yield* Effect.forEach(
          summaries.filter((c) => c.State !== "DELETING"),
          (summary) => getConnector(summary.Id ?? summary.Arn),
          { concurrency: 10 },
        );
        return connectors.flatMap((c) => (c ? [toAttrs(c)] : []));
      }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* resolveName(id, news.name);

      // Observe — prefer the cached identifier, falling back to a name lookup
      // so an interrupted create can recover before re-creating. A connector
      // stuck in DELETE_FAILED is treated as missing so we recreate.
      const found = output?.networkConnectorId
        ? yield* getConnector(output.networkConnectorId)
        : yield* getConnector(name);
      const observed =
        found && found.State !== "DELETE_FAILED" ? found : undefined;

      // Ensure + sync — each branch returns the active connector, so we never
      // reassign across branches (which `tsc` narrows poorly).
      const connector = observed
        ? yield* syncConnector(observed, name, news, session)
        : yield* createConnector(name, news, id, session);

      yield* session.note(`Network connector ${name} is ${connector.State}`);
      return toAttrs(connector);
    }),

    delete: Effect.fn(function* ({ output, session }) {
      yield* session.note(`Deleting network connector ${output.name}...`);
      yield* lambdacore
        .deleteNetworkConnector({ Identifier: output.networkConnectorId })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      yield* waitForDeleted(output.networkConnectorId, session);
    }),
  });

// === Helpers ===============================================================

const resolveName = (id: string, name?: string) =>
  name
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 64, delimiter: "-" });

// A freshly-created IAM operator role (and its inline policies) takes a few
// seconds to propagate before the Lambda service can assume/use it. The API
// surfaces that as an InvalidParameterValueException, so retry it briefly
// (same pattern as Function.ts's role-propagation retry). A genuinely
// misconfigured role still fails once the bounded retry window elapses.
const isOperatorRolePropagationError = (e: {
  _tag: string;
  message?: string;
}) =>
  e._tag === "InvalidParameterValueException" &&
  ((e.message?.includes(
    "unable to assume the provided NetworkConnectorOperatorRole",
  ) ??
    false) ||
    (e.message?.includes("invalid ConnectorOperatorRole permissions") ??
      false));

const retryRolePropagation =
  (session: ScopedPlanStatusSession) =>
  <A, E extends { _tag: string; message?: string }, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.tapError((e) =>
        isOperatorRolePropagationError(e)
          ? session.note(
              "Waiting for the operator role to become assumable by Lambda...",
            )
          : Effect.void,
      ),
      Effect.retry({
        while: (e) => isOperatorRolePropagationError(e),
        schedule: Schedule.max([Schedule.fixed(1_000), Schedule.recurs(50)]),
      }),
    );

const getConnector = (identifier: string) =>
  lambdacore
    .getNetworkConnector({ Identifier: identifier })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const normalizeList = (values: readonly string[] | undefined): string[] =>
  [...(values ?? [])].sort();

const desiredEgress = (
  props: NetworkConnectorProps,
): lambdacore.NetworkConnectorVpcEgressConfiguration => ({
  SubnetIds: props.subnetIds,
  SecurityGroupIds: props.securityGroupIds,
  NetworkProtocol: props.networkProtocol,
  // The API requires AssociatedComputeResourceTypes for VPC_EGRESS connectors,
  // so apply the documented default when the prop is omitted.
  AssociatedComputeResourceTypes: props.associatedComputeResourceTypes ?? [
    "MicroVm",
  ],
});

const egressEqual = (
  a: lambdacore.NetworkConnectorVpcEgressConfiguration | undefined,
  b: lambdacore.NetworkConnectorVpcEgressConfiguration | undefined,
): boolean =>
  deepEqual(
    {
      SubnetIds: normalizeList(a?.SubnetIds),
      SecurityGroupIds: normalizeList(a?.SecurityGroupIds),
      NetworkProtocol: a?.NetworkProtocol,
      AssociatedComputeResourceTypes: normalizeList(
        a?.AssociatedComputeResourceTypes,
      ),
    },
    {
      SubnetIds: normalizeList(b?.SubnetIds),
      SecurityGroupIds: normalizeList(b?.SecurityGroupIds),
      NetworkProtocol: b?.NetworkProtocol,
      AssociatedComputeResourceTypes: normalizeList(
        b?.AssociatedComputeResourceTypes,
      ),
    },
  );

const toIso = (value: Date | string | undefined): string | undefined =>
  value instanceof Date ? value.toISOString() : value;

const toAttrs = (
  connector: lambdacore.GetNetworkConnectorResponse,
): NetworkConnector["Attributes"] => {
  const egress = connector.Configuration?.VpcEgressConfiguration;
  return {
    networkConnectorArn: connector.Arn,
    networkConnectorId: connector.Id,
    name: connector.Name,
    state: connector.State ?? "PENDING",
    operatorRole: connector.OperatorRole,
    subnetIds: egress?.SubnetIds,
    securityGroupIds: egress?.SecurityGroupIds,
    networkProtocol: egress?.NetworkProtocol,
    associatedComputeResourceTypes: egress?.AssociatedComputeResourceTypes,
    version: connector.Version,
    lastModified: toIso(connector.LastModified),
  };
};

// Create the connector with ownership tags and wait for it to become ACTIVE.
const createConnector = Effect.fn(function* (
  name: string,
  news: NetworkConnectorProps,
  id: string,
  session: ScopedPlanStatusSession,
) {
  const internalTags = yield* createInternalTags(id);
  yield* session.note(`Creating network connector ${name}...`);
  const created = yield* lambdacore
    .createNetworkConnector({
      Name: name,
      Configuration: { VpcEgressConfiguration: desiredEgress(news) },
      OperatorRole: news.operatorRole,
      Tags: { ...internalTags, ...news.tags },
    })
    .pipe(
      retryRolePropagation(session),
      // A concurrent create with the same name is a race; fall back to reading
      // the existing connector.
      Effect.catchTag("ResourceConflictException", () =>
        getConnector(name).pipe(
          Effect.flatMap((existing) =>
            existing
              ? Effect.succeed(existing)
              : Effect.die(
                  `Network connector ${name} conflicted but was not found.`,
                ),
          ),
        ),
      ),
    );
  return yield* waitForActive(created.Id ?? created.Arn, session);
});

// Apply config / operator-role changes against observed state, waiting for the
// update to settle; otherwise return the observed connector untouched.
const syncConnector = Effect.fn(function* (
  connector: lambdacore.GetNetworkConnectorResponse,
  name: string,
  news: NetworkConnectorProps,
  session: ScopedPlanStatusSession,
) {
  const observedEgress = connector.Configuration?.VpcEgressConfiguration;
  if (
    egressEqual(observedEgress, desiredEgress(news)) &&
    (connector.OperatorRole ?? undefined) === news.operatorRole
  ) {
    return connector;
  }
  yield* session.note(`Updating network connector ${name}...`);
  yield* lambdacore
    .updateNetworkConnector({
      Identifier: connector.Id,
      Configuration: { VpcEgressConfiguration: desiredEgress(news) },
      OperatorRole: news.operatorRole,
    })
    .pipe(retryRolePropagation(session));
  return yield* waitForUpdate(connector.Id, session);
});

class ConnectorPending extends Data.TaggedError("ConnectorPending")<{
  identifier: string;
  state: string;
}> {}

class ConnectorFailed extends Data.TaggedError("ConnectorFailed")<{
  identifier: string;
  state: string;
  reason?: string;
}> {}

const waitForActive = (identifier: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const connector = yield* lambdacore.getNetworkConnector({
      Identifier: identifier,
    });
    switch (connector.State) {
      case "ACTIVE":
        return connector;
      case "FAILED":
      case "DELETE_FAILED":
        return yield* new ConnectorFailed({
          identifier,
          state: connector.State,
          reason: connector.StateReason ?? connector.StateReasonCode,
        });
      default:
        return yield* new ConnectorPending({
          identifier,
          state: connector.State ?? "PENDING",
        });
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ConnectorPending",
      schedule: Schedule.max([
        Schedule.fixed(10_000),
        Schedule.recurs(72),
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for network connector to become ACTIVE... (${attempt * 10}s)`,
          ),
        ),
      ),
    }),
  );

const waitForUpdate = (identifier: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const connector = yield* lambdacore.getNetworkConnector({
      Identifier: identifier,
    });
    switch (connector.LastUpdateStatus) {
      case "Successful":
      case undefined:
        return connector;
      case "Failed":
        return yield* new ConnectorFailed({
          identifier,
          state: connector.LastUpdateStatus,
          reason:
            connector.LastUpdateStatusReason ??
            connector.LastUpdateStatusReasonCode,
        });
      default:
        return yield* new ConnectorPending({
          identifier,
          state: connector.LastUpdateStatus ?? "InProgress",
        });
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ConnectorPending",
      schedule: Schedule.max([
        Schedule.fixed(10_000),
        Schedule.recurs(72),
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for network connector update... (${attempt * 10}s)`,
          ),
        ),
      ),
    }),
  );

const waitForDeleted = (identifier: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const connector = yield* lambdacore
      .getNetworkConnector({ Identifier: identifier })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    // A missing connector is the success signal — it has been deleted.
    if (!connector) return;
    if (connector.State === "DELETE_FAILED") {
      return yield* new ConnectorFailed({
        identifier,
        state: connector.State,
        reason: connector.StateReason ?? connector.StateReasonCode,
      });
    }
    return yield* new ConnectorPending({
      identifier,
      state: connector.State ?? "DELETING",
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ConnectorPending",
      schedule: Schedule.max([
        Schedule.fixed(10_000),
        Schedule.recurs(72),
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for network connector deletion... (${attempt * 10}s)`,
          ),
        ),
      ),
    }),
  );
