import type { EnvironmentId } from "@t3tools/contracts";
import { shareableOrigin } from "@t3tools/shared/threadLinks";
import * as Option from "effect/Option";

import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession } from "./session";

/** The environment's web app as another device reaches it: this phone's address, else a LAN or tailnet one. */
export function readShareableOrigin(environmentId: EnvironmentId): string | null {
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  return shareableOrigin([
    Option.isSome(connection) ? connection.value.httpBaseUrl : null,
    ...(config?.directEndpoints ?? []).map((endpoint) => endpoint.httpBaseUrl),
  ]);
}
