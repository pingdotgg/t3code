import {
  classifyLinearFailure,
  isLinearUnsupportedFailure,
} from "@t3tools/client-runtime/linear/degradation";
import type { EnvironmentId, LinearConnectionState } from "@t3tools/contracts";

interface LinearEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly isEnabled: boolean;
  readonly connectionState: string;
}

/**
 * The environment whose server holds the Linear key: the person's pick while it is connected,
 * else the first connected one. Mobile has no primary environment to default to.
 */
export function resolveLinearEnvironmentId(
  environments: ReadonlyArray<LinearEnvironmentCandidate>,
  selected: EnvironmentId | null,
): EnvironmentId | null {
  const connected = environments.filter(
    (environment) => environment.isEnabled && environment.connectionState === "connected",
  );
  return (
    connected.find((environment) => environment.environmentId === selected)?.environmentId ??
    connected[0]?.environmentId ??
    null
  );
}

/** Key of the thread-identifier map: thread ids are only unique within their environment. */
export function linearThreadKey(environmentId: string, threadId: string): string {
  return `${environmentId}\n${threadId}`;
}

export type LinearTabState =
  | "no-environment"
  | "unsupported"
  | "disconnected"
  | "invalid"
  | "unreachable"
  | "loading"
  | "connected";

/** What the Linear tab shows, from the environment pick and the status read. */
export function resolveLinearTabState(input: {
  readonly environmentId: EnvironmentId | null;
  readonly connection: LinearConnectionState | null;
  readonly failure: unknown;
  readonly hasError: boolean;
}): LinearTabState {
  if (input.environmentId === null) return "no-environment";
  if (input.connection === "connected") return "connected";
  if (input.connection === "invalid") return "invalid";
  if (input.connection === "disconnected") return "disconnected";
  if (isLinearUnsupportedFailure(input.failure)) return "unsupported";
  const kind = classifyLinearFailure(input.failure);
  if (kind === "unauthorized") return "invalid";
  if (kind === "not_connected") return "disconnected";
  return input.hasError ? "unreachable" : "loading";
}
