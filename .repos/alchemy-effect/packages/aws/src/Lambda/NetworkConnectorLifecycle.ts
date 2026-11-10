/**
 * Network connector lifecycle shared by `AWS.Lambda.NetworkConnector` and
 * `AWS.Lambda.WebFunction` (which manages a connector for its `vpc`).
 *
 * NOT exported from `index.ts`.
 */
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import { deepEqual } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { createInternalTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { NetworkConnectorProps } from "./NetworkConnector.ts";

// === Helpers ===============================================================

export const resolveName = (id: string, name?: string) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64, delimiter: "-" });

// A freshly-created IAM operator role (and its inline policies) takes a few
// seconds to propagate before Lambda can assume it. A genuinely misconfigured
// role still fails once the bounded retry window elapses.
export const isOperatorRolePropagationError = (e: { _tag: string }) =>
  e._tag === "OperatorRoleNotAssumable";

export const retryRolePropagation =
  (session: ScopedPlanStatusSession) =>
  <A, E extends { _tag: string }, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.tapError((e) =>
        isOperatorRolePropagationError(e)
          ? session.note("Waiting for the operator role to become assumable by Lambda...")
          : Effect.void,
      ),
      Effect.retry({
        while: (e) => isOperatorRolePropagationError(e),
        schedule: Schedule.max([Schedule.fixed(1_000), Schedule.recurs(50)]),
      }),
    );

export const getConnector = (identifier: string) =>
  lambdacore
    .getNetworkConnector({ Identifier: identifier })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

export const normalizeList = (values: readonly string[] | undefined): string[] =>
  [...(values ?? [])].sort();

export const desiredEgress = (
  props: NetworkConnectorProps,
): lambdacore.NetworkConnectorVpcEgressConfiguration => ({
  SubnetIds: props.subnetIds,
  SecurityGroupIds: props.securityGroupIds,
  // The API rejects a VPC_EGRESS connector without a protocol, so apply the
  // documented default.
  NetworkProtocol: props.networkProtocol ?? "IPv4",
  // The API requires AssociatedComputeResourceTypes for VPC_EGRESS connectors,
  // so apply the documented default when the prop is omitted.
  AssociatedComputeResourceTypes: props.associatedComputeResourceTypes ?? ["MicroVm"],
});

export const egressEqual = (
  a: lambdacore.NetworkConnectorVpcEgressConfiguration | undefined,
  b: lambdacore.NetworkConnectorVpcEgressConfiguration | undefined,
): boolean =>
  deepEqual(
    {
      SubnetIds: normalizeList(a?.SubnetIds),
      SecurityGroupIds: normalizeList(a?.SecurityGroupIds),
      NetworkProtocol: a?.NetworkProtocol,
      AssociatedComputeResourceTypes: normalizeList(a?.AssociatedComputeResourceTypes),
    },
    {
      SubnetIds: normalizeList(b?.SubnetIds),
      SecurityGroupIds: normalizeList(b?.SecurityGroupIds),
      NetworkProtocol: b?.NetworkProtocol,
      AssociatedComputeResourceTypes: normalizeList(b?.AssociatedComputeResourceTypes),
    },
  );

// Create the connector with ownership tags and wait for it to become ACTIVE.
export const createConnector = Effect.fn(function* (
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
              : Effect.die(`Network connector ${name} conflicted but was not found.`),
          ),
        ),
      ),
    );
  return yield* waitForActive(created.Id ?? created.Arn, session);
});

// Apply config / operator-role changes against observed state, waiting for the
// update to settle; otherwise return the observed connector untouched.
export const syncConnector = Effect.fn(function* (
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

export class ConnectorPending extends Data.TaggedError("ConnectorPending")<{
  identifier: string;
  state: string;
}> {}

export class ConnectorFailed extends Data.TaggedError("ConnectorFailed")<{
  identifier: string;
  state: string;
  reason?: string;
}> {}

export const waitForActive = (identifier: string, session: ScopedPlanStatusSession) =>
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
      schedule: Schedule.max([Schedule.fixed(10_000), Schedule.recurs(72)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for network connector to become ACTIVE... (${attempt * 10}s)`),
        ),
      ),
    }),
  );

export const waitForUpdate = (identifier: string, session: ScopedPlanStatusSession) =>
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
          reason: connector.LastUpdateStatusReason ?? connector.LastUpdateStatusReasonCode,
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
      schedule: Schedule.max([Schedule.fixed(10_000), Schedule.recurs(72)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for network connector update... (${attempt * 10}s)`),
        ),
      ),
    }),
  );

export const waitForDeleted = (identifier: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const connector = yield* lambdacore
      .getNetworkConnector({ Identifier: identifier })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
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
      schedule: Schedule.max([Schedule.fixed(10_000), Schedule.recurs(72)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(`Waiting for network connector deletion... (${attempt * 10}s)`),
        ),
      ),
    }),
  );
