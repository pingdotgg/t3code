import type { ResourceContext } from "@/ResourceContext.ts";

/**
 * A {@link ResourceContext} for tests that call a provider lifecycle method
 * or `createPhysicalName` directly, outside the engine (which normally
 * provides it).
 */
export const resourceContext = (
  instanceId: string,
  logicalId = "Resource",
): ResourceContext["Service"] => ({
  logicalId,
  fqn: logicalId,
  instanceId,
  type: "Test.Resource",
});
