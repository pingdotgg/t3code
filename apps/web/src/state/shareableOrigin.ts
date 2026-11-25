import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { shareableOrigin } from "@t3tools/shared/threadLinks";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { readPreparedConnection, usePreparedConnection } from "./session";

const originOf = (httpBaseUrl: string | null | undefined, config: ServerConfig | undefined) =>
  shareableOrigin([
    httpBaseUrl,
    ...(config?.directEndpoints ?? []).map((endpoint) => endpoint.httpBaseUrl),
  ]);

/** The environment's web app as another device reaches it: this client's address, else a LAN or tailnet one. */
export function readShareableOrigin(environmentId: EnvironmentId | null): string | null {
  if (environmentId === null) return null;
  return originOf(
    readPreparedConnection(environmentId)?.httpBaseUrl,
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
  );
}

export function useShareableOrigin(environmentId: EnvironmentId | null): string | null {
  const connection = usePreparedConnection(environmentId);
  const configs = useAtomValue(environmentServerConfigsAtom);
  return environmentId === null
    ? null
    : originOf(Option.getOrNull(connection)?.httpBaseUrl, configs.get(environmentId));
}
