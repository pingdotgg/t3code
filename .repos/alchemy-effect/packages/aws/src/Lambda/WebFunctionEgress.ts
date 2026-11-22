/**
 * Releasing a Web Function's egress network connector once nothing serves
 * through it. Shared by `AWS.Lambda.WebFunction` (its built-in endpoint) and
 * `AWS.Lambda.WebFunctionEndpoint`: whichever endpoint moves off the last
 * revision that used the connector cleans it up in the same deploy.
 *
 * NOT exported from `index.ts`.
 */
import * as iam from "@distilled.cloud/aws/iam";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { getConnector, waitForDeleted } from "./NetworkConnectorLifecycle.ts";

/** Inline policy on the egress operator role. */
export const EGRESS_POLICY = "AlchemyWebFunctionEgress";

/** `arn:…:network-connector:<id>:<version>` → `arn:…:network-connector:<id>`. */
const unversioned = (connectorArn: string) => connectorArn.slice(0, connectorArn.lastIndexOf(":"));

/** Whether two version-qualified ARNs name the same connector. */
export const sameConnector = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && unversioned(a) === unversioned(b);

/** The connector a revision routes egress through, if any. */
export const connectorOfRevision = (functionName: string, revisionId: string) =>
  LambdaWeb.getWebFunctionRevision({ functionName, revisionId }).pipe(
    Effect.map((revision) => revision.serviceConfig.egressNetworkConnectorArn),
    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
  );

/**
 * Delete the operator role Alchemy created for a connector: same name as the
 * connector, with the egress inline policy.
 */
export const deleteOperatorRole = (roleName: string) =>
  Effect.gen(function* () {
    yield* iam
      .deleteRolePolicy({ RoleName: roleName, PolicyName: EGRESS_POLICY })
      .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    yield* iam.deleteRole({ RoleName: roleName }).pipe(
      Effect.catchTag("NoSuchEntityException", () => Effect.void),
      Effect.retry({
        while: (e) =>
          e._tag === "DeleteConflictException" || e._tag === "ConcurrentModificationException",
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
  });

/**
 * Delete a connector and wait until its network interfaces are gone, then
 * its operator role (Lambda uses the role to remove the interfaces).
 */
export const deleteConnectorAndRole = (connectorId: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const connector = yield* getConnector(connectorId);
    if (connector === undefined) return;
    yield* lambdacore.deleteNetworkConnector({ Identifier: connector.Id }).pipe(
      // Conflict: another endpoint of the same deploy is already deleting it.
      Effect.catchTag(
        ["ResourceNotFoundException", "ResourceConflictException"],
        () => Effect.void,
      ),
    );
    yield* waitForDeleted(connector.Id, session);
    // Only the role Alchemy made for this connector (it shares the name).
    const roleName = connector.OperatorRole?.split("/").pop();
    if (roleName !== undefined && roleName === connector.Name) {
      yield* deleteOperatorRole(roleName);
    }
  });

/**
 * Release the connector a function's endpoint stopped using, once no
 * endpoint serves a revision that references it. Unused revisions that
 * still reference it are deleted first, as Lambda requires before a
 * connector goes. A connector still in use is left for the endpoint that
 * moves last.
 */
export const releaseEgressConnector = Effect.fn(function* ({
  functionName,
  connectorArn,
  session,
}: {
  functionName: string;
  connectorArn: string;
  session: ScopedPlanStatusSession;
}) {
  const connector = unversioned(connectorArn);
  const references = (arn: string | undefined) =>
    arn !== undefined && unversioned(arn) === connector;

  const endpoints = yield* LambdaWeb.listWebFunctionEndpoints.items({ functionName }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  const served = new Set(
    endpoints.flatMap((e) =>
      e.revisionWeights.filter((w) => w.weight > 0).map((w) => w.revisionId),
    ),
  );
  for (const revisionId of served) {
    if (references(yield* connectorOfRevision(functionName, revisionId))) return;
  }

  const revisions = yield* LambdaWeb.listWebFunctionRevisions.items({ functionName }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const revision of revisions) {
    if (served.has(revision.revisionId)) continue;
    if (references(yield* connectorOfRevision(functionName, revision.revisionId))) {
      yield* LambdaWeb.deleteWebFunctionRevision({
        functionName,
        revisionId: revision.revisionId,
      }).pipe(
        // Conflict: started serving again in the meantime, so leave it.
        Effect.catchTag(["ResourceNotFoundException", "ConflictException"], () => Effect.void),
      );
    }
  }

  yield* session.note(`Releasing unused network connector ${connector.split(":").pop()}`);
  yield* deleteConnectorAndRole(connector.split(":").pop()!, session);
});
