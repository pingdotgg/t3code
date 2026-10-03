import {
  BearerConnectionTarget,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { EnvironmentPresentation } from "../state/environments";

/** A paired remote as the web app presents it; every field a scope helper reads is overridable. */
export function makeEnvironmentPresentation(input: {
  id: string;
  label?: string;
  displayUrl?: string | null;
  enabled?: boolean;
  phase?: EnvironmentConnectionPhase;
}): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(input.id);
  const label = input.label ?? input.id;
  return {
    environmentId,
    label,
    displayUrl: input.displayUrl ?? null,
    relayManaged: false,
    entry: {
      target: new BearerConnectionTarget({ environmentId, connectionId: input.id, label }),
      profile: Option.none(),
      enabled: input.enabled ?? true,
    },
    connection: { phase: input.phase ?? "connected", error: null, traceId: null },
    serverConfig: null,
  };
}
