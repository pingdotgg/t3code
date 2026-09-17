import * as Effect from "effect/Effect";
import {
  type GetServiceDeploymentsResponse,
  getServiceDeployments,
} from "@distilled.cloud/prisma/management";
import { PrismaPaginationError } from "./Pagination.ts";

/** Prove that a deployment belongs to an App before mutating or deleting it. */
export const ensureDeploymentMembership = Effect.fn(function* (
  appId: string,
  deployment: { id: string; foundryVersionId: string },
  knownLatestDeploymentId?: string | null,
) {
  if (knownLatestDeploymentId === deployment.id) return;
  // Distilled emits the cursor-paginated list operations as plain ops, so
  // callers walk `pagination` themselves (see `src/Neon/Project.ts`).
  const deployments: GetServiceDeploymentsResponse["data"][number][] = [];
  let cursor: string | undefined;
  while (true) {
    const page = yield* getServiceDeployments(
      cursor === undefined
        ? { serviceId: appId }
        : { serviceId: appId, cursor },
    );
    deployments.push(...page.data);
    const nextCursor = page.pagination.nextCursor;
    if (!page.pagination.hasMore) break;
    if (nextCursor === null) {
      return yield* Effect.fail(
        new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getServiceDeployments: hasMore was true without a non-empty nextCursor",
        }),
      );
    }
    cursor = nextCursor;
  }
  const matches = deployments.filter(
    (candidate) => candidate.id === deployment.id,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.foundryVersionId !== deployment.foundryVersionId
  ) {
    return yield* Effect.fail(
      new Error(
        `Prisma deployment '${deployment.id}' with Foundry version '${deployment.foundryVersionId}' is not uniquely owned by App '${appId}'. Refusing to start, promote, or delete a mismatched deployment.`,
      ),
    );
  }
});
