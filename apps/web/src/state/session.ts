import type { EnvironmentId } from "@t3tools/contracts";

import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";

export interface PreparedEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
}

/**
 * Fork adapter for the browser slice: the preview code only needs the HTTP
 * base URL of a connected environment, which the fork tracks in its saved
 * environment catalog rather than in a connection atom.
 */
export function readPreparedConnection(
  environmentId: EnvironmentId,
): PreparedEnvironmentConnection | null {
  const httpBaseUrl = getEnvironmentHttpBaseUrl(environmentId);
  return httpBaseUrl === null ? null : { environmentId, httpBaseUrl };
}
