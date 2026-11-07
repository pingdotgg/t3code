import type { EnvironmentId } from "@t3tools/contracts";

export type MarkJump = {
  readonly path: string | null;
  readonly line: number;
  readonly requestId: number;
  readonly baselineRouteLine: number | null;
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
};

export type MarkJumpRoute = {
  readonly path: string | null;
  readonly routeLine: number | null;
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
};

/** Keep a mark jump only while path, route line, and workspace still match. */
export function reconcileMarkJump(
  markJump: MarkJump | null,
  route: MarkJumpRoute,
): MarkJump | null {
  if (markJump === null) return null;
  if (
    markJump.path !== route.path ||
    markJump.baselineRouteLine !== route.routeLine ||
    markJump.cwd !== route.cwd ||
    markJump.environmentId !== route.environmentId
  ) {
    return null;
  }
  return markJump;
}
