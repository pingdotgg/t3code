import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type LinkedThreadRouteParams = {
  readonly viaEnvironmentId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly label: string;
  readonly title?: string;
};

/** The route params that open a linked environment's thread read-only. */
export const linkedThreadRouteParams = (
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  linked: { readonly viaEnvironmentId: EnvironmentId; readonly label: string },
  title: string | null,
): LinkedThreadRouteParams => ({
  viaEnvironmentId: linked.viaEnvironmentId,
  environmentId: thread.environmentId,
  threadId: thread.threadId,
  label: linked.label,
  ...(title === null ? {} : { title }),
});
