/**
 * Preserve both the reconcile failure and a subsequent cleanup failure.
 *
 * Cleanup failures are operationally important: suppressing one can leave an
 * untracked cloud resource behind with no indication of how to remove it.
 */
export const aggregateCleanupFailure = (
  resource: "App" | "deployment",
  resourceId: string,
  route: string,
  originalError: unknown,
  cleanupError: unknown,
) =>
  new AggregateError(
    [originalError, cleanupError],
    `Failed to clean up Prisma ${resource} '${resourceId}' after reconcile failed. The resource may be orphaned. Manual cleanup: DELETE ${route}.`,
  );
