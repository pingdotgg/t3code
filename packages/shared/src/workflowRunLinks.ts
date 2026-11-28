import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isEnvironmentId = Schema.is(EnvironmentId);

export interface WorkflowRunLink {
  readonly env: EnvironmentId;
  readonly run: string;
}

// Distinguish malformed run links so callers can keep them out of generic link navigation.
export function parseWorkflowRunHref(
  href: string | undefined,
): WorkflowRunLink | "invalid-environment" | null {
  if (!href?.startsWith("/workflows?")) return null;
  const { searchParams } = new URL(href, "https://example.invalid");
  const env = searchParams.get("env");
  const run = searchParams.get("run");
  if (env === null || !run) return null;
  return isEnvironmentId(env) ? { env, run } : "invalid-environment";
}
